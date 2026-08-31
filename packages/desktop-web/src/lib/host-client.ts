/**
 * Host-side session client for the daemon's JSON-RPC WebSocket.
 *
 * The "runtime serves the renderer" compat chain: this client connects to the
 * daemon as a host (bearer token, not a collab room key), calls
 * session.subscribe for the initial snapshot + live event stream, and feeds
 * the same GuestSnapshot shape the guest renderer consumes.
 *
 * The renderer (Transcript, tool cards, composer) is identical — only the
 * transport and auth differ.
 */
import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@musepi/pi-wire";
import type {
	ActiveTool,
	ApprovalRequest,
	ConnectionPhase,
	GuestSnapshot,
	Notice,
	SessionClient,
	TranscriptResult,
} from "./client.js";

interface PendingRpc {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
}

/** How long to wait for a JSON-RPC response before timing out. */
const RPC_TIMEOUT_MS = 15_000;

/** Narrow an unknown wire value to a plain record (single property reads). */
function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * Host client: connects to the daemon WS via ?token=, JSON-RPC for
 * session.subscribe, then processes entry/event/state events.
 */
export class HostClient implements SessionClient {
	readonly #wsUrl: string;
	readonly #token: string | undefined;
	#ws: WebSocket | null = null;
	#rpcSeq = 0;
	#pending = new Map<number, PendingRpc>();
	#listeners = new Set<() => void>();

	// Session state (mirrors GuestClient's internal state).
	#sessionId: string | null = null;
	#header: SessionHeader | null = null;
	#entries: SessionEntry[] = [];
	#state: SessionState | null = null;
	#agents: AgentSnapshot[] = [];
	#progress = new Map<string, SubagentProgressPayload>();
	#lifecycle = new Map<string, SubagentLifecyclePayload>();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools = new Map<string, ActiveTool>();
	#working = false;
	#roundDurations = new Map<number, number>();
	#notices: Notice[] = [];
	#uiRequest: CollabUiRequest | null = null;
	#approvalRequest: ApprovalRequest | null = null;
	/** Daemon `askRequestId` (string) keyed by the CollabUiRequest `reqId` the
	 *  composer answers with — the two id spaces differ. */
	#askReqIds = new Map<number, string>();
	#askSeq = 0;
	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;

	constructor(wsUrl: string, token?: string) {
		this.#wsUrl = wsUrl;
		this.#token = token;
	}

	connect(): void {
		if (this.#ws) return;
		const wsUrl = this.#token ? `${this.#wsUrl}?token=${encodeURIComponent(this.#token)}` : this.#wsUrl;
		const ws = new WebSocket(wsUrl);
		ws.onopen = () => this.#onOpen();
		ws.onmessage = (ev: MessageEvent) => this.#onMessage(ev.data);
		ws.onclose = (ev: CloseEvent) => this.#onClose(ev.reason || "connection closed");
		ws.onerror = () => {
			/* onclose fires after error */
		};
		this.#ws = ws;
	}

	close(): void {
		this.#ws?.close();
		this.#ws = null;
		this.#phase = "ended";
		this.#endedReason = "closed";
		this.#clearPending(new Error("closed"));
		this.#notify();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getSnapshot(): GuestSnapshot {
		return {
			phase: this.#phase,
			endedReason: this.#endedReason,
			header: this.#header,
			entries: this.#entries,
			state: this.#state,
			agents: this.#agents,
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			stream: this.#stream,
			streamDone: this.#streamDone,
			activeTools: this.#activeTools,
			working: this.#working,
			roundDurations: this.#roundDurations,
			readOnly: false,
			workspace: null,
			focusedSessionId: this.#sessionId,
			uiRequest: this.#uiRequest,
			uiRequestPending: false,
			approvalRequest: this.#approvalRequest,
			notices: this.#notices,
		};
	}

	sendPrompt(text: string): void {
		if (!this.#sessionId) return;
		void this.#rpc("session.send", { sessionId: this.#sessionId, text, deliverAs: "prompt" });
	}

	sendAbort(): void {
		if (!this.#sessionId) return;
		void this.#rpc("session.abort", { sessionId: this.#sessionId });
	}

	selectWorkspaceSession(_sessionId: string | null): void {
		// No-op: host-mode has a single session (no workspace directory).
	}

	sendUiResponse(reqId: number, value?: string): void {
		const requestId = this.#askReqIds.get(reqId);
		if (!requestId || !this.#sessionId) return;
		void this.rpc("session.askAnswer", {
			sessionId: this.#sessionId,
			requestId,
			answer: value ?? null,
		});
	}

	respondApproval(requestId: string, approve: boolean): void {
		if (!this.#sessionId) return;
		void this.rpc(approve ? "tool.approve" : "tool.deny", {
			sessionId: this.#sessionId,
			requestId,
		});
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		if (cmd === "chat") {
			void this.rpc("agents.chat", { agentId, text });
		} else {
			void this.rpc(cmd === "kill" ? "agents.kill" : "agents.revive", { agentId });
		}
	}

	async fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		try {
			const res = (await this.rpc("agents.transcript", { agentId, fromByte })) as {
				text?: string;
				newSize?: number;
				error?: string;
			};
			if (typeof res.error === "string") return { kind: "error", message: res.error };
			if (typeof res.text === "string" && typeof res.newSize === "number") {
				return { kind: "rows", text: res.text, newSize: res.newSize };
			}
			return null;
		} catch {
			return null;
		}
	}

	rpc<T>(method: string, params?: unknown): Promise<T> {
		return this.#rpc(method, params) as Promise<T>;
	}

	get plaintext(): boolean {
		return false;
	}

	get workspace(): null {
		return null;
	}

	get focusedSessionId(): string | null {
		return this.#sessionId;
	}

	get approvalRequest(): ApprovalRequest | null {
		return this.#approvalRequest;
	}

	#onOpen(): void {
		void this.#bootstrap();
	}

	async #bootstrap(): Promise<void> {
		try {
			// 1. List sessions and pick the most recent.
			const sessions = (await this.#rpc("session.list", {})) as Array<{
				id: string;
			}>;
			let sessionId = sessions[0]?.id;
			if (!sessionId) {
				// No sessions yet — create one (cwd defaults daemon-side).
				const created = (await this.#rpc("session.create", {})) as { id: string };
				sessionId = created.id;
			}

			// 2. Subscribe to the session (initial snapshot + live events).
			this.#sessionId = sessionId;
			const result = (await this.#rpc("session.subscribe", { sessionId })) as {
				initial: {
					header: SessionHeader;
					entries: SessionEntry[];
					state: SessionState;
					agents: AgentSnapshot[];
					activeTools?: Array<{
						toolCallId: string;
						toolName: string;
						args?: unknown;
						intent?: string;
						partialResult?: string;
					}>;
					agentsProgress?: Array<{ id: string; progress: SubagentProgressPayload }>;
				};
			};

			// 3. Apply initial state.
			const initial = result.initial;
			this.#header = initial.header;
			this.#entries = initial.entries;
			this.#state = initial.state;
			this.#agents = initial.agents;
			this.#working = initial.state?.isStreaming === true;
			for (const tool of initial.activeTools ?? []) {
				this.#activeTools.set(tool.toolCallId, {
					toolCallId: tool.toolCallId,
					toolName: tool.toolName,
					args: tool.args,
					intent: tool.intent,
					partialResult: tool.partialResult,
					startedAt: Date.now(),
				});
			}
			for (const ap of initial.agentsProgress ?? []) {
				this.#progress.set(ap.id, ap.progress);
			}
			this.#phase = "live";
			this.#notify();
		} catch (err) {
			this.#phase = "ended";
			this.#endedReason = err instanceof Error ? err.message : String(err);
			this.#notify();
		}
	}

	#onMessage(data: unknown): void {
		let msg: unknown;
		try {
			msg = typeof data === "string" ? JSON.parse(data) : data;
		} catch {
			return;
		}
		const record = asRecord(msg);
		if (!record) return;

		// JSON-RPC response.
		if ("jsonrpc" in record && "id" in record) {
			const response = record as {
				id: number;
				result?: unknown;
				error?: { code: number; message: string };
			};
			const pending = this.#pending.get(response.id);
			if (!pending) return;
			this.#pending.delete(response.id);
			clearTimeout(pending.timeout);
			if (response.error) {
				pending.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`));
			} else {
				pending.resolve(response.result);
			}
			return;
		}

		// Subscription event (bare { kind, seq, payload }).
		if (!("kind" in record)) return;
		const kind = record.kind;
		const payload = record.payload;
		if (typeof kind !== "string") return;
		this.#handleStreamEvent(kind, payload);
	}

	#handleStreamEvent(kind: string, payload: unknown): void {
		switch (kind) {
			case "entry": {
				// Protocol contract: entry payload is a SessionEntry.
				if (!asRecord(payload)) return;
				const entry = payload as SessionEntry;
				this.#entries = [...this.#entries, entry];
				// If we held a stream ghost for this entry, clear it.
				if (this.#stream && entry.type === "message" && entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				break;
			}
			case "event": {
				const record = asRecord(payload);
				if (!record) return;
				this.#applyEvent(record);
				break;
			}
			case "state": {
				const record = asRecord(payload);
				if (!record) return;
				// Protocol contract: state payload is a SessionState.
				this.#state = record as unknown as SessionState;
				this.#working = this.#state?.isStreaming === true;
				break;
			}
			case "agent-progress": {
				const record = asRecord(payload);
				if (!record || !("id" in record) || typeof record.id !== "string" || !("progress" in record)) {
					return;
				}
				this.#progress = new Map(this.#progress).set(record.id, record.progress as SubagentProgressPayload);
				break;
			}
			case "agent-lifecycle": {
				const record = asRecord(payload);
				if (!record || !("id" in record) || typeof record.id !== "string") return;
				this.#lifecycle = new Map(this.#lifecycle).set(record.id, record as unknown as SubagentLifecyclePayload);
				break;
			}
			case "stream-end": {
				const record = asRecord(payload);
				this.#phase = "ended";
				this.#endedReason =
					record && "reason" in record && typeof record.reason === "string" ? record.reason : "stream ended";
				break;
			}
			case "approval-request": {
				const record = asRecord(payload);
				if (!record || !("requestId" in record) || typeof record.requestId !== "string") return;
				this.#approvalRequest = {
					requestId: record.requestId,
					tool: typeof record.tool === "string" ? record.tool : "tool",
					args: record.args,
					prompt: typeof record.prompt === "string" ? record.prompt : null,
				};
				break;
			}
			case "ask-request": {
				const record = asRecord(payload);
				if (!record || !("requestId" in record) || typeof record.requestId !== "string") return;
				const numId = ++this.#askSeq;
				this.#askReqIds.set(numId, record.requestId);
				const title = typeof record.title === "string" ? record.title : "question";
				const mode = record.mode;
				if (mode === "select") {
					const options = Array.isArray(record.options)
						? record.options.filter((o): o is string => typeof o === "string")
						: [];
					this.#uiRequest = {
						kind: "select",
						title,
						options,
						selectionMarker: record.multi === true ? "checkbox" : "radio",
						reqId: numId,
					};
				} else if (mode === "input") {
					this.#uiRequest = {
						kind: "editor",
						title,
						prefill: typeof record.prefill === "string" ? record.prefill : undefined,
						reqId: numId,
					};
				} else {
					// mode "dialog" (multi-question) — Composer has no renderer;
					// surface as a notice so the host is not blind.
					this.#pushNotice("info", title);
				}
				break;
			}
			case "recap": {
				const record = asRecord(payload);
				if (record && "text" in record && typeof record.text === "string") {
					this.#pushNotice("info", record.text);
				}
				break;
			}
			default:
				// pause-state, global-pause-state, title — ignore for the
				// minimal host view.
				break;
		}
		this.#notify();
	}

	#applyEvent(event: Record<string, unknown>): void {
		// Mirrors GuestClient.#applyEvent. Fields are narrowed with `in`
		// before use; the event payload is the daemon's wire agent event.
		const type = event.type;
		if (typeof type !== "string") return;

		switch (type) {
			case "message_start":
			case "message_update":
			case "message_end": {
				const message = asRecord(event.message);
				if (message && message.role === "assistant") {
					// Protocol contract: message payload is an AssistantMessage.
					this.#stream = message as unknown as AssistantMessage;
					this.#streamDone = type === "message_end";
				}
				break;
			}
			case "tool_execution_start":
			case "tool_execution_update":
			case "tool_execution_end": {
				const toolCallId = event.toolCallId;
				if (typeof toolCallId !== "string") return;
				if (type === "tool_execution_end") {
					const next = new Map(this.#activeTools);
					next.delete(toolCallId);
					this.#activeTools = next;
					break;
				}
				const toolName = event.toolName;
				if (typeof toolName !== "string") return;
				const existing = this.#activeTools.get(toolCallId);
				const tool: ActiveTool = existing
					? {
							...existing,
							...(typeof event.partialResult === "string" ? { partialResult: event.partialResult } : {}),
						}
					: {
							toolCallId,
							toolName,
							args: event.args,
							intent: typeof event.intent === "string" ? event.intent : undefined,
							...(typeof event.partialResult === "string" ? { partialResult: event.partialResult } : {}),
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(toolCallId, tool);
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				// Freeze this run's round duration (final assistant message ts
				// → ms since the last user message).
				{
					let userTs: number | undefined;
					let assistantTs: number | undefined;
					for (const e of this.#entries) {
						if (e.type !== "message") continue;
						if (e.message.role === "user") userTs = e.message.timestamp;
						else if (e.message.role === "assistant") assistantTs = e.message.timestamp;
					}
					if (this.#stream?.role === "assistant") assistantTs = this.#stream.timestamp;
					if (userTs !== undefined && assistantTs !== undefined) {
						this.#roundDurations = new Map(this.#roundDurations).set(assistantTs, Date.now() - userTs);
					}
				}
				break;
			case "notice": {
				const level = event.level;
				const message = event.message;
				if ((level === "info" || level === "error" || level === "warning") && typeof message === "string") {
					this.#pushNotice(level, message);
				}
				break;
			}
			case "auto_retry_start": {
				const attempt = event.attempt;
				const maxAttempts = event.maxAttempts;
				const errorMessage = event.errorMessage;
				if (typeof attempt === "number" && typeof maxAttempts === "number" && typeof errorMessage === "string") {
					this.#pushNotice("info", `retry ${attempt}/${maxAttempts}: ${errorMessage}`);
				}
				break;
			}
			case "auto_retry_end": {
				if (event.success === false) {
					this.#pushNotice("error", typeof event.finalError === "string" ? event.finalError : "retry failed");
				}
				break;
			}
			case "auto_compaction_start": {
				const reason = event.reason;
				if (typeof reason === "string") {
					this.#pushNotice("info", `compacting context (${reason})`);
				}
				break;
			}
			case "auto_compaction_end": {
				if (event.skipped !== true) {
					this.#pushNotice(
						"info",
						event.aborted === true
							? "compaction aborted"
							: typeof event.errorMessage === "string"
								? `compaction failed: ${event.errorMessage}`
								: "context compacted",
					);
				}
				break;
			}
			default:
				// turn_start, turn_end, thinking_level_changed, irc_message,
				// ttsr_triggered — ignore for the minimal host view.
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: this.#notices.length, level, message, at: Date.now() };
		this.#notices = [...this.#notices, notice].slice(-50);
	}

	#onClose(reason: string): void {
		this.#phase = "ended";
		this.#endedReason = reason;
		this.#clearPending(new Error(`disconnected: ${reason}`));
		this.#notify();
	}

	#rpc(method: string, params: unknown): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => {
			const id = ++this.#rpcSeq;
			this.#pending.set(id, {
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.#pending.delete(id);
					reject(new Error(`RPC timeout: ${method}`));
				}, RPC_TIMEOUT_MS),
			});
			this.#ws?.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		});
	}

	#clearPending(reason: Error): void {
		for (const [, pending] of this.#pending) {
			clearTimeout(pending.timeout);
			pending.reject(reason);
		}
		this.#pending.clear();
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// listener error — non-fatal
			}
		}
	}
}
