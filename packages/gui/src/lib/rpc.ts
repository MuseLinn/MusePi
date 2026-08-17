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
}

/** Timer handle as typed by bun-types (browser bundle overrides). */
type TimerHandle = Timer;

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

	/** Backoff retry (openchamber scheduleReconnect parity). */
	#scheduleReconnect(): void {
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
			this.#pending.set(id, {
				resolve: v => resolve(v as T),
				reject,
			});
			ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	/** Wire the message handler (called once after connect; loops internally). */
	run(): void {
		const ws = this.#ws;
		if (!ws) return;
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
				// JSON-RPC response.
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
			}
		});
		ws.addEventListener("close", () => {
			this.#ws = null;
			if (!this.#closedByUser) {
				for (const { reject } of this.#pending.values()) reject(new Error("connection closed"));
				this.#pending.clear();
				this.#onStatus?.("closed");
				// Unannounced drop (daemon restart, machine sleep): retry forever.
				this.#scheduleReconnect();
			}
		});
	}
}
