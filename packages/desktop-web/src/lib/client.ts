/**
 * Guest-side session replica for the collab web client.
 *
 * Owns the relay socket, applies host frames in strict arrival order, and
 * exposes an immutable {@link GuestSnapshot} through a
 * `useSyncExternalStore`-compatible subscribe/getSnapshot pair. The snapshot
 * object (and every replaced collection inside it) gets a new reference per
 * applied frame, so React change detection is reference equality all the way.
 */

import { COLLAB_PROTO, CollabSocket, encodeBase64Url, importRoomKey, parseCollabLink } from "@musepi/collab-proto";
import type {
	AgentSnapshot,
	AssistantMessage,
	CollabUiRequest,
	CollabUiResponseValue,
	GuestFrame,
	HostFrame,
	SessionEntry,
	SessionHeader,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	WorkspaceSessionInfo,
} from "@musepi/pi-wire";
import type { TranslationKey } from "../i18n/index.js";
import { t } from "../i18n/index.js";

export type ConnectionPhase = "connecting" | "waiting" | "live" | "workspace" | "reconnecting" | "ended";

/** Listener notification window: frames inside it coalesce into one render. */
const BATCH_WINDOW_MS = 16;

export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface Notice {
	id: number;
	level: "info" | "warning" | "error";
	message: string;
	at: number;
}

/** Daemon `approval-request` event payload — a tool call awaiting the host's
 *  approve/deny. `prompt` is the full formatted body (Allow tool / Reason /
 *  command+args) the GUI card shows so the host decides on the real action. */
export interface ApprovalRequest {
	requestId: string;
	tool: string;
	args: unknown;
	prompt: string | null;
}

/** The client surface the shell renders against — shared by the collab guest
 *  (GuestClient) and the daemon host (HostClient) transports. The host view
 *  implements the workspace/UI-request members as inert stubs. */
export interface SessionClient {
	subscribe(listener: () => void): () => void;
	getSnapshot(): GuestSnapshot;
	sendPrompt(text: string): void;
	sendAbort(): void;
	selectWorkspaceSession(sessionId: string | null): void;
	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void;
	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void;
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null>;
	rpc<T>(method: string, params?: unknown): Promise<T>;
	/** Pending tool approval for the host to approve/deny (see
	 *  {@link ApprovalRequest}); null when none. The collab guest never sees
	 *  approvals — always null. */
	readonly approvalRequest: ApprovalRequest | null;
	respondApproval(requestId: string, approve: boolean): void;
	readonly plaintext: boolean;
	readonly workspace: readonly WorkspaceSessionInfo[] | null;
	readonly focusedSessionId: string | null;
}

export interface GuestSnapshot {
	phase: ConnectionPhase;
	endedReason: string | null;
	header: SessionHeader | null;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	agents: readonly AgentSnapshot[];
	/** Keyed by `payload.progress.id`. */
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	/** Keyed by `payload.id`. */
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Streaming assistant ghost; held until the matching entry lands. */
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	/** agent_start..agent_end, reconciled by state.isStreaming. */
	working: boolean;
	/** Frozen per-round totals (final assistant msg ts → ms) — each completed
	 *  round's "已工作 X 秒" stays under its final message. */
	roundDurations: ReadonlyMap<number, number>;
	/** True when this guest joined through a read-only (view) link. */
	readOnly: boolean;
	/** Multi-session workspace directory (workspace-mode shares). */
	workspace: readonly WorkspaceSessionInfo[] | null;
	/** Session currently streamed after a workspace focus; null on the directory. */
	focusedSessionId: string | null;
	/** Pending host-side UI request (`ask` select/editor) this guest can answer. */
	uiRequest: CollabUiRequest | null;
	/** True while a multi-select (checkbox) ui-request awaits the host's
	 *  re-issue after the guest toggled an option — the dialog stays mounted
	 *  and options are disabled until the follow-up frame arrives. */
	uiRequestPending: boolean;
	/** Pending tool approval the host must approve/deny (daemon host-mode only;
	 *  the collab guest never sees approvals — always null). */
	approvalRequest: ApprovalRequest | null;
	/** Capped at 50, newest last. */
	notices: readonly Notice[];
}

const MAX_NOTICES = 50;
const TRANSCRIPT_TIMEOUT_MS = 10_000;
/** Mirrors the TUI guest's WELCOME_TIMEOUT_MS: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's SNAPSHOT_PROGRESS_TIMEOUT_MS: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;

/**
 * One fetch-transcript round trip.
 * - `rows`: decoded JSONL from `fromByte`; `newSize` is the next offset base.
 * - `error`: terminal read failure reported by the host (unchanged cursor);
 *   callers must surface it and stop polling instead of hot retrying.
 * Transient failures (timeout, session end) resolve `null` and are retryable.
 */
export type TranscriptResult = { kind: "rows"; text: string; newSize: number } | { kind: "error"; message: string };

interface PendingTranscript {
	resolve: (result: TranscriptResult | null) => void;
	timer: Timer;
}

interface PendingRpc {
	resolve: (data: unknown) => void;
	reject: (err: Error) => void;
}

export class GuestClient {
	readonly #socket: CollabSocket<HostFrame, GuestFrame>;
	readonly #name: string;
	/** Invoked once when the first `welcome` frame lands — the host accepted
	 *  the join. Used by the app shell to persist the connection (recent
	 *  list, URL hash) only after the handshake actually succeeded; a failed
	 *  or timed-out connect never fires it. */
	onWelcome?: () => void;
	/** Plaintext (no E2E) guest — browser on insecure http without crypto.subtle. */
	readonly #plaintext: boolean;
	/** base64url write token from a full link; absent when joined via a view link. */
	readonly #writeToken: string | undefined;
	readonly #listeners = new Set<() => void>();
	readonly #pendingTranscripts = new Map<number, PendingTranscript>();
	readonly #pendingRpcs = new Map<number, PendingRpc>();
	#reqSeq = 0;
	#rpcSeq = 0;
	#noticeSeq = 0;
	#everConnected = false;
	#welcomed = false;
	#welcomeTimer: Timer | null = null;
	#snapshotProgressTimer: Timer | null = null;

	#phase: ConnectionPhase = "connecting";
	#endedReason: string | null = null;
	#header: SessionHeader | null = null;
	#entries: readonly SessionEntry[] = [];
	#state: SessionState | null = null;
	#agents: readonly AgentSnapshot[] = [];
	#progress: ReadonlyMap<string, SubagentProgressPayload> = new Map();
	#lifecycle: ReadonlyMap<string, SubagentLifecyclePayload> = new Map();
	#stream: AssistantMessage | null = null;
	#streamDone = false;
	#activeTools: ReadonlyMap<string, ActiveTool> = new Map();
	#working = false;
	#roundDurations: ReadonlyMap<number, number> = new Map();
	#readOnly = false;
	#workspace: readonly WorkspaceSessionInfo[] | null = null;
	#focusedSessionId: string | null = null;
	#uiRequest: CollabUiRequest | null = null;
	#uiRequestPending = false;
	#uiRequestQueue: CollabUiRequest[] = [];
	#notices: readonly Notice[] = [];
	#snapshot: GuestSnapshot;
	/** Non-null while a window flush of listener notifications is pending. */
	#flushTimer: Timer | null = null;

	/** @throws Error when the link does not parse. */
	constructor(link: string, displayName: string, options: { plaintext?: boolean } = {}) {
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		this.#name = displayName;
		this.#plaintext = !!options.plaintext;
		this.#writeToken = parsed.writeToken ? encodeBase64Url(parsed.writeToken) : undefined;
		this.#socket = new CollabSocket<HostFrame, GuestFrame>({
			wsUrl: parsed.wsUrl,
			role: "guest",
			plaintext: this.#plaintext,
			key: this.#plaintext ? undefined : importRoomKey(parsed.key),
		});
		this.#socket.onOpen = () => this.#handleOpen();
		this.#socket.onFrame = frame => this.#applyFrameSafe(frame);
		this.#socket.onControl = msg => {
			if (msg.t === "room-closed") this.#end(t("room closed"));
		};
		this.#socket.onClose = (reason, willReconnect) => this.#handleClose(reason, willReconnect);
		this.#snapshot = this.#buildSnapshot();
	}

	connect(): void {
		if (this.#phase === "ended") {
			this.#phase = "connecting";
			this.#endedReason = null;
			this.#commit();
		}
		this.#socket.connect();
		if (!this.#welcomed && this.#welcomeTimer === null) {
			this.#welcomeTimer = setTimeout(() => {
				this.#welcomeTimer = null;
				if (!this.#welcomed) this.#end(t("timed out waiting for the host's welcome"));
			}, WELCOME_TIMEOUT_MS);
		}
	}

	close(): void {
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#socket.close();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Cached stable reference; replaced (with fresh collection refs) per applied frame. */
	getSnapshot(): GuestSnapshot {
		return this.#snapshot;
	}

	/** True when this guest joined in plaintext mode (no E2E encryption). */
	get plaintext(): boolean {
		return this.#plaintext;
	}

	sendPrompt(text: string): void {
		this.#socket.send({ t: "prompt", text });
	}

	sendUiResponse(reqId: number, value?: CollabUiResponseValue): void {
		this.#socket.send({ t: "ui-response", reqId, value });
		if (this.#uiRequest?.reqId === reqId) {
			// Multi-select (checkbox) questions run a host-side toggle loop:
			// the host re-issues a fresh request (new reqId, same title) with
			// the updated checked set. Keep the dialog mounted in a pending
			// state until the follow-up replaces it, so the mobile ask UI
			// doesn't flash away mid-selection. Single-choice settles at once.
			if (this.#uiRequest.kind === "select" && this.#uiRequest.selectionMarker === "checkbox") {
				this.#uiRequestPending = true;
			} else {
				this.#showNextUiRequest();
			}
			this.#commit();
		}
	}

	sendAbort(): void {
		this.#socket.send({ t: "abort" });
	}

	/** Multi-session workspace directory; null in single-session shares. */
	get workspace(): readonly WorkspaceSessionInfo[] | null {
		return this.#workspace;
	}

	/** Session the guest is currently streaming, or null on the directory. */
	get focusedSessionId(): string | null {
		return this.#focusedSessionId;
	}

	/** Focus a session from the workspace directory (null returns to it). */
	selectWorkspaceSession(sessionId: string | null): void {
		this.#focusedSessionId = sessionId;
		if (sessionId !== null) {
			// A focus switch streams a fresh welcome; reset the live accumulators.
			this.#entries = [];
			this.#stream = null;
			this.#streamDone = false;
			this.#activeTools = new Map();
			this.#progress = new Map();
			this.#lifecycle = new Map();
			this.#working = false;
			this.#phase = "waiting";
		}
		this.#socket.send({ t: "workspace-select", sessionId });
		this.#commit();
	}

	sendAgentCmd(cmd: "chat" | "kill" | "revive", agentId: string, text?: string): void {
		this.#socket.send({ t: "agent-cmd", cmd, agentId, text });
	}

	/** Tool approvals are host-side only (the collab guest never receives
	 *  `approval-request` frames) — a no-op on the guest transport. */
	respondApproval(_requestId: string, _approve: boolean): void {
		// no-op
	}

	/** Tool approvals are host-side only — always null on the guest. */
	get approvalRequest(): null {
		return null;
	}

	/**
	 * Incremental subagent-transcript read. Resolves a {@link TranscriptResult}
	 * (`rows` or terminal `error`), or `null` on transient failure (10s timeout,
	 * session end) where re-polling from the same cursor is correct.
	 */
	fetchTranscript(agentId: string, fromByte: number): Promise<TranscriptResult | null> {
		const reqId = ++this.#reqSeq;
		const { promise, resolve } = Promise.withResolvers<TranscriptResult | null>();
		const timer = setTimeout(() => {
			this.#pendingTranscripts.delete(reqId);
			resolve(null);
		}, TRANSCRIPT_TIMEOUT_MS);
		this.#pendingTranscripts.set(reqId, { resolve, timer });
		this.#socket.send({ t: "fetch-transcript", reqId, agentId, fromByte });
		return promise;
	}

	/**
	 * Host RPC: board / cron / workspace / fs capabilities. Resolves with the
	 * method's data payload; rejects with the host's error string when the
	 * host answers `ok:false`. No timeout — the host always answers (mirrors
	 * the fetch-transcript pending-map pattern without the polling fallback).
	 */
	rpc<T>(method: string, params?: unknown): Promise<T> {
		const reqId = ++this.#rpcSeq;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.#pendingRpcs.set(reqId, {
			resolve: resolve as PendingRpc["resolve"],
			reject,
		});
		this.#socket.send({ t: "rpc-request", reqId, method, params });
		return promise;
	}

	/** Test seam: apply a synthetic host frame through the real apply path. */
	applyFrameForTest(frame: HostFrame): void {
		this.#applyFrameSafe(frame);
	}

	#handleOpen(): void {
		this.#socket.send({ t: "hello", proto: COLLAB_PROTO, name: this.#name, writeToken: this.#writeToken });
		this.#phase = this.#everConnected ? "reconnecting" : "waiting";
		this.#everConnected = true;
		this.#commit();
	}

	#handleClose(reason: string, willReconnect: boolean): void {
		this.#clearSnapshotProgressTimer();
		if (this.#phase === "ended") return;
		if (willReconnect) {
			this.#phase = "reconnecting";
			this.#commit();
			return;
		}
		this.#end(this.#translateCloseReason(reason));
	}

	/**
	 * CollabSocket emits raw English reasons; translate at the UI layer (the
	 * socket is a pure transport). "connection lost (code N)" carries a code
	 * that must be extracted before matching the `{0}`-placeholder key.
	 */
	#translateCloseReason(reason: string): string {
		const codeMatch = /^connection lost \(code (\d+)\)$/.exec(reason);
		if (codeMatch) {
			return t("connection lost (code {code})", { code: codeMatch[1]! });
		}
		return t(reason as TranslationKey);
	}

	#end(reason: string): void {
		if (this.#phase === "ended") return;
		this.#clearWelcomeTimer();
		this.#clearSnapshotProgressTimer();
		this.#phase = "ended";
		this.#endedReason = reason;
		for (const [, pending] of this.#pendingTranscripts) {
			clearTimeout(pending.timer);
			pending.resolve(null);
		}
		this.#pendingTranscripts.clear();
		for (const [, pending] of this.#pendingRpcs) {
			pending.reject(new Error(reason));
		}
		this.#pendingRpcs.clear();
		this.#clearUiRequests();
		this.#commit();
		this.#socket.close();
	}

	#clearWelcomeTimer(): void {
		if (this.#welcomeTimer !== null) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}

	#armSnapshotProgressTimer(): void {
		this.#clearSnapshotProgressTimer();
		this.#snapshotProgressTimer = setTimeout(() => {
			this.#snapshotProgressTimer = null;
			this.#end(t("timed out waiting for the host's session snapshot"));
		}, SNAPSHOT_PROGRESS_TIMEOUT_MS);
	}

	#clearSnapshotProgressTimer(): void {
		if (this.#snapshotProgressTimer !== null) {
			clearTimeout(this.#snapshotProgressTimer);
			this.#snapshotProgressTimer = null;
		}
	}

	/** Surfaces apply failures instead of letting the socket's recv chain swallow them. */
	#applyFrameSafe(frame: HostFrame): void {
		try {
			this.#applyFrame(frame);
		} catch (err) {
			console.warn("collab: failed to apply frame", frame.t, err);
			if (frame.t === "welcome" && !this.#welcomed) {
				this.#end(
					t("failed to apply session snapshot: {reason}", {
						reason: err instanceof Error ? err.message : String(err),
					}),
				);
				return;
			}
			this.#pushNotice("error", t("failed to apply {frame} frame", { frame: frame.t }));
			this.#commit();
		}
	}

	#applyFrame(frame: HostFrame): void {
		switch (frame.t) {
			case "welcome":
				// First welcome = the join handshake succeeded. Fire the shell's
				// persistence hook once so failed/timed-out connects never record.
				if (!this.#welcomed) this.onWelcome?.();
				// Reset accumulator: a fresh welcome arriving mid-load (reconnect)
				// supersedes any partially-streamed snapshot from the prior session.
				this.#header = frame.header;
				this.#entries = [];
				this.#state = frame.state;
				this.#agents = [...frame.agents];
				this.#stream = null;
				this.#streamDone = false;
				this.#activeTools = new Map();
				this.#progress = new Map();
				this.#lifecycle = new Map();
				this.#working = frame.state.isStreaming;
				this.#readOnly = frame.readOnly === true;
				this.#clearUiRequests();
				this.#welcomed = true;
				this.#clearWelcomeTimer();
				if (frame.entryCount === 0) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				this.#endedReason = null;
				break;
			case "snapshot-chunk": {
				// Stream transcript fragments into the live snapshot. The host
				// always closes the train with `final: true`; that flip is what
				// moves the guest from "waiting" to "live".
				this.#entries = [...this.#entries, ...frame.entries];
				if (frame.final) {
					this.#clearSnapshotProgressTimer();
					this.#phase = "live";
				} else {
					this.#armSnapshotProgressTimer();
				}
				break;
			}
			case "entry":
				this.#entries = [...this.#entries, frame.entry];
				if (this.#streamDone && frame.entry.type === "message" && frame.entry.message.role === "assistant") {
					this.#stream = null;
					this.#streamDone = false;
				}
				break;
			case "event":
				this.#applyEvent(frame.event);
				break;
			case "state":
				this.#state = frame.state;
				// Host state is authoritative for liveness in both directions: the
				// payload is built at fire time, so `isStreaming` is never stale.
				// This covers a connected guest that misses the discrete `agent_start`
				// without receiving a new `welcome` (for example, mid-stream).
				this.#working = frame.state.isStreaming;
				if (!frame.state.isStreaming) {
					// Host idle implies no tool can be running, so clear any card
					// pinned by a dropped `tool_execution_end` off this signal.
					this.#activeTools = new Map();
					if (this.#streamDone) {
						this.#stream = null;
						this.#streamDone = false;
					}
				}
				break;
			case "agents":
				this.#agents = [...frame.agents];
				break;
			case "bus":
				if (frame.channel === "task:subagent:progress") {
					const payload = frame.data as SubagentProgressPayload;
					this.#progress = new Map(this.#progress).set(payload.progress.id, payload);
				} else if (frame.channel === "task:subagent:lifecycle") {
					const payload = frame.data as SubagentLifecyclePayload;
					this.#lifecycle = new Map(this.#lifecycle).set(payload.id, payload);
				}
				break;
			case "ui-request":
				// A host re-issue of a multi-select loop (pending checkbox) replaces
				// the current request in place; a genuinely new request queues.
				if (this.#uiRequest && this.#uiRequestPending && this.#uiRequest.title === frame.request.title) {
					this.#uiRequest = frame.request;
					this.#uiRequestPending = false;
				} else if (this.#uiRequest) {
					this.#uiRequestQueue = [...this.#uiRequestQueue, frame.request];
				} else {
					this.#uiRequest = frame.request;
				}
				break;
			case "ui-request-end":
				this.#uiRequestPending = false;
				if (this.#uiRequest?.reqId === frame.reqId) this.#showNextUiRequest();
				else this.#uiRequestQueue = this.#uiRequestQueue.filter(request => request.reqId !== frame.reqId);
				break;
			case "transcript": {
				const pending = this.#pendingTranscripts.get(frame.reqId);
				if (pending) {
					this.#pendingTranscripts.delete(frame.reqId);
					clearTimeout(pending.timer);
					pending.resolve(
						frame.error !== undefined
							? { kind: "error", message: frame.error }
							: { kind: "rows", text: frame.text, newSize: frame.newSize },
					);
				}
				break;
			}
			case "rpc-result": {
				const pending = this.#pendingRpcs.get(frame.reqId);
				if (pending) {
					this.#pendingRpcs.delete(frame.reqId);
					if (frame.ok) pending.resolve(frame.data);
					else pending.reject(new Error(frame.error ?? "rpc failed"));
				}
				break;
			}
			case "workspace":
				this.#workspace = frame.sessions;
				this.#focusedSessionId = null;
				this.#phase = "workspace";
				// Workspace mode never sends a welcome until a session is
				// focused — cancel the hello timeout or guests time out on
				// the directory.
				this.#clearWelcomeTimer();
				break;
			case "workspace-session":
				if (this.#workspace !== null) {
					this.#workspace = this.#workspace.map(s => (s.id === frame.session.id ? frame.session : s));
				}
				break;
			case "bye":
				this.#end(frame.reason);
				return; // #end already committed
			case "error":
				if (!this.#welcomed && this.#workspace === null) {
					// Pre-welcome errors are the host's targeted reply to our
					// hello (e.g. protocol mismatch): no welcome will follow.
					// End with the host's reason instead of waiting out the
					// welcome timeout. (Workspace directory: a failed session
					// focus must not kill the connection — toast instead.)
					this.#end(frame.message);
					return; // #end already committed
				}
				// A failed workspace focus returns the guest to the directory.
				if (this.#workspace !== null && this.#focusedSessionId !== null) {
					this.#focusedSessionId = null;
					this.#phase = "workspace";
				}
				this.#pushNotice("error", frame.message);
				break;
			default:
				// unknown frame type from a newer host — ignore
				break;
		}
		this.#commit();
	}

	#applyEvent(event: Extract<HostFrame, { t: "event" }>["event"]): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = false;
				}
				break;
			case "message_end":
				if (event.message.role === "assistant") {
					this.#stream = event.message;
					this.#streamDone = true;
				}
				break;
			case "tool_execution_start": {
				const tool: ActiveTool = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					startedAt: Date.now(),
				};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_update": {
				const existing = this.#activeTools.get(event.toolCallId);
				const tool: ActiveTool = existing
					? { ...existing, partialResult: event.partialResult }
					: {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							args: event.args,
							partialResult: event.partialResult,
							startedAt: Date.now(),
						};
				this.#activeTools = new Map(this.#activeTools).set(event.toolCallId, tool);
				break;
			}
			case "tool_execution_end": {
				const next = new Map(this.#activeTools);
				next.delete(event.toolCallId);
				this.#activeTools = next;
				break;
			}
			case "agent_start":
				this.#working = true;
				break;
			case "agent_end":
				this.#working = false;
				// Freeze this run's total (craft-agents completedAt parity): the
				// round spans the last user message to agent_end; pinned to the
				// final assistant message so its row shows the frozen total.
				{
					let userTs: number | undefined;
					let assistantTs: number | undefined;
					for (const e of this.#entries) {
						if (e.type !== "message") continue;
						if (e.message.role === "user") userTs = e.message.timestamp;
						else if (e.message.role === "assistant") assistantTs = e.message.timestamp;
					}
					// The final message's entry frame can land AFTER agent_end —
					// the stream ghost still holds it then (cleared once the
					// entry folds in), so prefer it as the round's last message.
					if (this.#stream?.role === "assistant") assistantTs = this.#stream.timestamp;
					if (userTs !== undefined && assistantTs !== undefined) {
						const next = new Map(this.#roundDurations);
						next.set(assistantTs, Date.now() - userTs);
						this.#roundDurations = next;
					}
				}
				break;
			case "notice":
				this.#pushNotice(event.level, event.message);
				break;
			case "auto_retry_start":
				this.#pushNotice(
					"info",
					t("retry {attempt}/{max}: {reason}", {
						attempt: String(event.attempt),
						max: String(event.maxAttempts),
						reason: event.errorMessage,
					}),
				);
				break;
			case "auto_retry_end":
				if (!event.success) this.#pushNotice("error", event.finalError ?? t("retry failed"));
				break;
			case "auto_compaction_start":
				this.#pushNotice("info", t("compacting context ({reason})", { reason: event.reason }));
				break;
			case "auto_compaction_end":
				if (!event.skipped) {
					this.#pushNotice(
						"info",
						event.aborted
							? t("compaction aborted")
							: event.errorMessage
								? t("compaction failed: {reason}", { reason: event.errorMessage })
								: t("context compacted"),
					);
				}
				break;
			default:
				// turn_start/turn_end/thinking_level_changed/unknown — ignore
				break;
		}
	}

	#pushNotice(level: Notice["level"], message: string): void {
		const notice: Notice = { id: ++this.#noticeSeq, level, message, at: Date.now() };
		const next = [...this.#notices, notice];
		if (next.length > MAX_NOTICES) next.splice(0, next.length - MAX_NOTICES);
		this.#notices = next;
	}

	#clearUiRequests(): void {
		this.#uiRequest = null;
		this.#uiRequestPending = false;
		this.#uiRequestQueue = [];
	}

	#showNextUiRequest(): void {
		const [next, ...rest] = this.#uiRequestQueue;
		this.#uiRequest = next ?? null;
		this.#uiRequestQueue = rest;
	}

	#buildSnapshot(): GuestSnapshot {
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
			readOnly: this.#readOnly,
			workspace: this.#workspace,
			focusedSessionId: this.#focusedSessionId,
			uiRequest: this.#uiRequest,
			uiRequestPending: this.#uiRequestPending,
			approvalRequest: null,
			notices: this.#notices,
		};
	}

	/**
	 * Publish a state change. The snapshot is updated synchronously —
	 * `getSnapshot()` always reflects the latest applied frame, so callers
	 * (and tests) may read it immediately. Only the listener notification is
	 * deferred: frames arriving within one BATCH_WINDOW_MS window coalesce
	 * into a single render.
	 *
	 * The window is wall-clock (not a microtask) because wire frames arrive
	 * one task apart (a WS message per chunk) — a microtask flush would run
	 * between frames and batch nothing. 16ms bounds the echo delay below a
	 * perceptible frame while folding a token burst into ~1 render per
	 * animation frame.
	 *
	 * No `notifyNow` path exists because no controlled input reads the
	 * snapshot — composer drafts and ask editors keep local state, so a
	 * window-delayed echo can never roll a caret back.
	 */
	#commit(): void {
		this.#snapshot = this.#buildSnapshot();
		if (this.#flushTimer !== null) return;
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = null;
			for (const listener of this.#listeners) listener();
		}, BATCH_WINDOW_MS);
	}
}
