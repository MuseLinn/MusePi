/**
 * Browser JSON-RPC 2.0 client over the daemon's WebSocket transport
 * (src/daemon/ws-transport.ts).
 *
 * The daemon multiplexes two kinds of frames on one connection:
 * - JSON-RPC responses: `{ jsonrpc, id, result | error }` (id matches a
 *   pending request);
 * - subscription events: bare `{ kind, seq, payload }` envelopes pushed by
 *   session.subscribe / session.resume (no jsonrpc/id fields).
 *
 * Callers can attach an event handler to receive the second kind; requests
 * resolve against their id. Reconnecting restores nothing — the session UI
 * drives resume via session.resume after reconnect.
 */

export interface RpcError {
	code: number;
	message: string;
	data?: unknown;
}

export interface StreamEvent {
	kind: string;
	seq: number;
	payload: unknown;
	/** Subscribing session (B1: multi-session routing). Absent for
	 *  UI-command/global envelopes (terminal, pause, provider). */
	sessionId?: string;
}

/** Timer handle as typed by bun-types (browser bundle overrides). */
type TimerHandle = Timer;

/** A request unanswered this long is rejected (dead socket / hung daemon) —
 *  without this, a silently-dead connection hangs every caller forever. */
const REQUEST_TIMEOUT_MS = 15_000;
/** App-level keepalive cadence. Browsers cannot send WS ping frames, so
 *  liveness is probed with a lightweight RPC ("system.ping"). */
const KEEPALIVE_INTERVAL_MS = 20_000;
/** No response of ANY kind for this long ⇒ the socket is silently dead
 *  (macOS sleep tears the connection down without a close frame on wake);
 *  force-close so the close handler's reconnect path takes over. */
const KEEPALIVE_DEAD_MS = 45_000;

export class RpcClient {
	readonly #url: string;
	#ws: WebSocket | null = null;
	#nextId = 1;
	readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	#onEvent: ((event: StreamEvent) => void) | null = null;
	#extraEvents = new Set<(event: StreamEvent) => void>();
	#onStatus: ((phase: "connecting" | "open" | "closed") => void) | null = null;
	#closedByUser = false;
	// ── Auto-reconnect (openchamber parity: terminalApi.scheduleReconnect).
	// Exponential backoff capped at 8s (60s while the tab is hidden or the
	// machine offline — i.e. the lid is closed); becoming visible again or
	// the network returning wakes the retry immediately. Reconnect restores
	// the socket only — the app re-runs session.resume for the open session.
	#reconnectTimer: TimerHandle | null = null;
	#wakeCleanup: (() => void) | null = null;
	#failures = 0;
	// ── Liveness (sleep/wake freeze fix, 2026-08-20): last response time +
	// a ping loop. The close event does NOT fire for a silently-dead socket
	// (Electron tears WebSockets down on system sleep; the renderer resumes
	// with a half-open connection) — without detection the UI hangs forever.
	#lastPongAt = 0;
	#pingTimer: TimerHandle | null = null;

	constructor(url: string) {
		this.#url = url;
	}

	set onEvent(handler: ((event: StreamEvent) => void) | null) {
		this.#onEvent = handler;
	}

	/** Subscribe a second listener (terminal panel etc.) alongside onEvent. */
	addEventListener(handler: (event: StreamEvent) => void): () => void {
		this.#extraEvents.add(handler);
		return () => this.#extraEvents.delete(handler);
	}

	set onStatus(handler: ((phase: "connecting" | "open" | "closed") => void) | null) {
		this.#onStatus = handler;
	}

	/** Open the socket. Does not resolve until the connection is open. */
	connect(): Promise<void> {
		this.#closedByUser = false;
		this.#onStatus?.("connecting");
		const ws = new WebSocket(this.#url);
		this.#ws = ws;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const onOpen = (): void => {
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("error", onError);
			this.#onStatus?.("open");
			resolve();
		};
		const onError = (): void => {
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("error", onError);
			reject(new Error(`cannot connect to ${this.#url}`));
		};
		ws.addEventListener("open", onOpen);
		ws.addEventListener("error", onError);
		return promise;
	}

	/** Cancel a pending reconnect and its wake listeners. */
	#cancelReconnect(): void {
		clearTimeout(this.#reconnectTimer ?? undefined);
		this.#reconnectTimer = null;
		this.#wakeCleanup?.();
		this.#wakeCleanup = null;
	}

	/** Start the liveness ping loop (called on every successful open). */
	#startKeepalive(): void {
		this.#stopKeepalive();
		this.#lastPongAt = Date.now();
		this.#pingTimer = setInterval(() => {
			const ws = this.#ws;
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			// No response of any kind within the budget ⇒ silently dead —
			// force close so the close handler's reconnect path recovers.
			if (Date.now() - this.#lastPongAt > KEEPALIVE_DEAD_MS) {
				console.error("[rpc] keepalive: connection unresponsive — closing");
				ws.close();
				return;
			}
			try {
				// The ping rides #pending like any request: its response (or
				// the request timeout) updates #lastPongAt via the message
				// handler, and a stale entry is cleaned up on timeout/close.
				const id = this.#nextId++;
				this.#pending.set(id, {
					resolve: () => {},
					reject: () => {},
				});
				ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: "system.ping", params: {} }));
			} catch {
				// Dead socket — the close event fires and recovery takes over.
			}
		}, KEEPALIVE_INTERVAL_MS);
	}

	#stopKeepalive(): void {
		clearInterval(this.#pingTimer ?? undefined);
		this.#pingTimer = null;
	}

	/** Backoff retry (openchamber scheduleReconnect parity). */
	#scheduleReconnect(): void {
		if (this.#closedByUser) return;
		if (this.#reconnectTimer) return;
		this.#failures += 1;
		const slow =
			(typeof document !== "undefined" && document.visibilityState === "hidden") ||
			(typeof navigator !== "undefined" && !navigator.onLine);
		const delay = Math.min(500 * 2 ** Math.min(this.#failures - 1, 10), slow ? 60_000 : 8_000);
		// Waking from sleep (lid open → visibilitychange/online) retries right
		// away instead of waiting out the backoff.
		const wake = (): void => {
			if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
			if (typeof navigator !== "undefined" && !navigator.onLine) return;
			clearTimeout(this.#reconnectTimer ?? undefined);
			this.#reconnectTimer = null;
			this.#wakeCleanup?.();
			this.#wakeCleanup = null;
			void this.#retry();
		};
		if (typeof window !== "undefined") window.addEventListener("online", wake);
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
		this.#wakeCleanup = () => {
			if (typeof window !== "undefined") window.removeEventListener("online", wake);
			if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
		};
		this.#reconnectTimer = setTimeout(wake, delay);
	}

	async #retry(): Promise<void> {
		if (this.#closedByUser) return;
		this.#onStatus?.("connecting");
		try {
			await this.connect();
			this.#failures = 0;
			console.log("[rpc] reconnected");
			this.run();
		} catch {
			// Requests sent on the dead connection can never be answered —
			// reject them instead of hanging the caller forever.
			for (const { reject } of this.#pending.values()) reject(new Error("connection closed"));
			this.#pending.clear();
			this.#scheduleReconnect();
		}
	}

	close(): void {
		this.#closedByUser = true;
		this.#cancelReconnect();
		this.#stopKeepalive();
		this.#ws?.close();
		this.#ws = null;
		for (const { reject } of this.#pending.values()) reject(new Error("connection closed"));
		this.#pending.clear();
	}

	request<T = unknown>(method: string, params?: unknown): Promise<T> {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			// A request on a silently-dead socket would otherwise hang the
			// caller forever (no close frame arrives on macOS sleep teardown)
			// — bound every request so the UI stays responsive and the
			// keepalive loop decides whether the socket itself is dead.
			const timer = setTimeout(() => {
				if (!this.#pending.has(id)) return;
				this.#pending.delete(id);
				reject(new Error(`request timeout: ${method}`));
			}, REQUEST_TIMEOUT_MS);
			this.#pending.set(id, {
				resolve: v => {
					clearTimeout(timer);
					resolve(v as T);
				},
				reject: e => {
					clearTimeout(timer);
					reject(e);
				},
			});
			ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	/** Wire the message handler (called once after connect; loops internally). */
	run(): void {
		const ws = this.#ws;
		if (!ws) return;
		this.#startKeepalive();
		ws.addEventListener("message", (ev: MessageEvent<string>) => {
			let msg: unknown;
			try {
				msg = JSON.parse(ev.data) as unknown;
			} catch {
				return;
			}
			if (typeof msg !== "object" || msg === null) return;
			const m = msg as Record<string, unknown>;
			if (typeof m.jsonrpc === "string" && typeof m.id === "number") {
				// JSON-RPC response — any response proves the socket is alive.
				this.#lastPongAt = Date.now();
				const id = m.id as number;
				const pending = this.#pending.get(id);
				if (!pending) return;
				this.#pending.delete(id);
				if ("error" in m && m.error) {
					pending.reject(new Error(String((m.error as RpcError).message ?? "RPC error")));
				} else {
					pending.resolve(m.result);
				}
				return;
			}
			// Subscription event envelope: { kind, seq, payload }.
			if (typeof m.kind === "string" && typeof m.seq === "number") {
				const event = m as unknown as StreamEvent;
				this.#onEvent?.(event);
				for (const handler of this.#extraEvents) handler(event);
				return;
			}
			// Coalesced frame (daemon EventBatcher): { kind: "batch", events }.
			// Inner envelopes keep their own seq — fan out exactly like
			// individually-framed envelopes so consumers see no difference.
			if (m.kind === "batch" && Array.isArray(m.events)) {
				for (const inner of m.events as unknown[]) {
					if (typeof inner !== "object" || inner === null) continue;
					const event = inner as StreamEvent;
					this.#onEvent?.(event);
					for (const handler of this.#extraEvents) handler(event);
				}
				return;
			}
		});
		ws.addEventListener("close", (ev: CloseEvent) => {
			this.#ws = null;
			this.#stopKeepalive();
			if (!this.#closedByUser) {
				// Surface the wire close code so an abnormal drop (1006 = no
				// status, renderer crash / transport loss) is distinguishable
				// from a clean server close (1000) in the error banner and
				// console — the daemon logs its side too (ws-transport).
				const code = typeof ev.code === "number" ? ev.code : 1006;
				const detail = code === 1000 ? "" : ` (code ${code}${ev.reason ? `: ${ev.reason}` : ""})`;
				const message = `connection closed${detail}`;
				console.error(`[rpc] ${message}`);
				for (const { reject } of this.#pending.values()) reject(new Error(message));
				this.#pending.clear();
				this.#onStatus?.("closed");
				// Unannounced drop (daemon restart, machine sleep): retry forever.
				this.#scheduleReconnect();
			}
		});
	}
}
