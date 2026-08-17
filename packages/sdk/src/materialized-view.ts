/**
 * Materialized session view — the projection layer of the daemon's
 * event-sourcing pipeline (gui-architecture Phase 3), shared with browser
 * clients.
 *
 * The journal (append-only wire AgentEvents) is the single source of truth.
 * This module projects it into a queryable session state:
 *
 *   wire AgentEvent  ──apply()──►  in-memory projection  ──snapshot()──►  SessionSnapshot
 *        (journal)                                                        (SDK contract)
 *
 * The persisted form IS the SessionSnapshot (fully JSON-safe), so
 * view-store stores exactly what `snapshot()` returns and `fromSnapshot()`
 * restores it without replay. The journal remains authoritative: a stale or
 * missing persisted row degrades to a journal replay, never to data loss.
 *
 * This module is deliberately browser-safe (pure logic, type-only pi-wire
 * imports): the collab guest and the GUI apply the same projection on the
 * client side to render incremental events, so the daemon and its browser
 * clients never drift.
 *
 * Projection rules (V1 — wire events only, per the wire-format decision):
 * - message_start/update/end → MessageEntry (deduped by message id; end
 *   carries the final message). Entries keep first-appearance order.
 * - thinking_level_changed → ThinkingLevelChangeEntry
 * - agent_start/end → main-agent lifecycle in `agents` (wire events carry no
 *   agent id, so the session's main agent is "main")
 * - turn_start/end → state.isStreaming
 * - tool_execution_* / notice / auto_compaction_* / auto_retry_* are already
 *   represented in the message stream (assistant toolCalls + ToolResultMessage)
 *   or have no SessionState field — not projected in V1.
 */
import type {
	AgentEvent,
	AgentSnapshot,
	CustomMessageEntry,
	MessageEntry,
	SessionEntry,
	SessionState,
	ThinkingLevelChangeEntry,
	WireMessage,
} from "@musepi/pi-wire";
import type { SessionSnapshot } from "./events";

/** Stable identity of a wire message across start/update/end evolution. */
export function messageKey(message: WireMessage): string {
	if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
	return `${message.role}:${message.timestamp}`;
}

export class MaterializedView {
	readonly #sessionId: string;
	readonly #cwd: string;
	#cursor = 0;
	readonly #createdAt: string;
	readonly #messages = new Map<string, MessageEntry>();
	readonly #entries: SessionEntry[] = [];
	#mainAgent: AgentSnapshot | null = null;
	#isStreaming = false;
	// Extra header fields (user-picked model/thinking/title for history
	// sessions) survive the round-trip: snapshot() re-emits them.
	readonly #headerExtra: { title?: string; model?: string; thinkingLevel?: string } = {};

	constructor(
		sessionId: string,
		cwd: string,
		createdAt?: string,
		headerExtra?: { title?: string; model?: string; thinkingLevel?: string },
	) {
		this.#sessionId = sessionId;
		this.#cwd = cwd;
		this.#createdAt = createdAt ?? new Date().toISOString();
		this.#headerExtra = headerExtra ?? {};
	}

	/** Build a view by replaying journal records (startup / recovery path). */
	static replay(sessionId: string, cwd: string, events: AgentEvent[], createdAt?: string): MaterializedView {
		const view = new MaterializedView(sessionId, cwd, createdAt);
		for (const event of events) view.apply(event);
		return view;
	}

	/** Restore from a persisted snapshot (SessionSnapshot). Returns null on malformed input. */
	static fromSnapshot(sessionId: string, cwd: string, raw: unknown): MaterializedView | null {
		if (typeof raw !== "object" || raw === null) return null;
		const snap = raw as Partial<SessionSnapshot>;
		if (!Array.isArray(snap.entries) || typeof snap.cursor !== "number") return null;
		const header = (typeof snap.header === "object" && snap.header ? snap.header : {}) as {
			timestamp?: string;
			title?: string;
			model?: string;
			thinkingLevel?: string;
		};
		const view = new MaterializedView(sessionId, cwd, String(header.timestamp ?? ""), {
			...(header.title !== undefined ? { title: header.title } : {}),
			...(header.model !== undefined ? { model: header.model } : {}),
			...(header.thinkingLevel !== undefined ? { thinkingLevel: header.thinkingLevel } : {}),
		});
		view.#cursor = snap.cursor;
		for (const entry of snap.entries as SessionEntry[]) {
			if (entry.type === "message" && entry.message) {
				view.#messages.set(entry.id, entry);
			}
			view.#entries.push(entry);
		}
		if (Array.isArray(snap.agents) && snap.agents.length > 0) {
			view.#mainAgent = snap.agents[0] as AgentSnapshot;
		}
		view.#isStreaming = (snap.state as SessionState | undefined)?.isStreaming ?? false;
		return view;
	}

	/** Incrementally project one wire event. Must be called in journal seq order. */
	apply(event: AgentEvent): void {
		this.#cursor += 1;
		switch (event.type) {
			case "message_start":
			case "message_update":
			case "message_end": {
				this.#upsertMessage(event.message);
				break;
			}
			case "thinking_level_changed": {
				const entry: ThinkingLevelChangeEntry = {
					type: "thinking_level_change",
					id: `tlc-${this.#cursor}`,
					parentId: null,
					timestamp: new Date().toISOString(),
					thinkingLevel: event.thinkingLevel ?? null,
				};
				this.#entries.push(entry);
				break;
			}
			case "ttsr_triggered": {
				// Rule violation → stream rewind + rule inject: surfaced as a
				// warning entry (the transcript renders the TTSR block).
				const entry: CustomMessageEntry = {
					type: "custom_message",
					id: `ttsr-${this.#cursor}`,
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: "ttsr",
					content: event.rules.map(r => r.name).join("、"),
					display: true,
					details: { rules: event.rules },
				};
				this.#entries.push(entry);
				break;
			}
			case "irc_message": {
				// Peer/agent coordination message (irc-bridge): render as a
				// custom row so inter-agent chatter is visible in the GUI.
				const m = event.message;
				const entry: CustomMessageEntry = {
					type: "custom_message",
					id: `irc-${this.#cursor}`,
					parentId: null,
					timestamp: new Date(m.timestamp).toISOString(),
					customType: m.customType,
					content: m.content,
					display: m.display,
					details: m.details,
				};
				this.#entries.push(entry);
				break;
			}
			case "agent_start": {
				if (!this.#mainAgent) {
					this.#mainAgent = {
						id: "main",
						displayName: "main",
						kind: "main",
						status: "running",
						hasSessionFile: false,
						createdAt: Date.now(),
						lastActivity: Date.now(),
					};
				} else {
					this.#mainAgent.status = "running";
					this.#mainAgent.lastActivity = Date.now();
				}
				break;
			}
			case "agent_end": {
				if (this.#mainAgent) {
					this.#mainAgent.status = "idle";
					this.#mainAgent.lastActivity = Date.now();
				}
				break;
			}
			case "turn_start": {
				this.#isStreaming = true;
				break;
			}
			case "turn_end": {
				this.#isStreaming = false;
				break;
			}
			// tool_execution_* / notice / auto_compaction_* / auto_retry_*:
			// no dedicated SessionState field or SessionEntry type in V1 — the
			// assistant message's toolCalls + ToolResultMessage entries already
			// carry the tool trace. See module doc.
			default:
				break;
		}
	}

	#upsertMessage(message: WireMessage): void {
		const key = messageKey(message);
		const existing = this.#messages.get(key);
		if (existing) {
			// Replace, never mutate in place: consumers (GUI transcript rows)
			// memoize on the entry object reference, so streamed content must
			// arrive as a NEW entry object for the row to re-render. The old
			// in-place write froze the row at its message_start frame.
			const updated: MessageEntry = { ...existing, message };
			this.#messages.set(key, updated);
			const idx = this.#entries.indexOf(existing);
			if (idx !== -1) this.#entries[idx] = updated;
			return;
		}
		const entry: MessageEntry = {
			type: "message",
			id: key,
			parentId: null,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		};
		this.#messages.set(key, entry);
		this.#entries.push(entry);
	}

	/** Current cursor (= last applied event seq). */
	get cursor(): number {
		return this.#cursor;
	}

	/** SDK-contract snapshot. Cheap: no journal read. */
	snapshot(): SessionSnapshot {
		const state: SessionState = {
			isStreaming: this.#isStreaming,
			queuedMessageCount: 0,
			cwd: this.#cwd,
			participants: [],
		};
		const agents = this.#mainAgent ? [this.#mainAgent] : [];
		return {
			header: {
				type: "session",
				id: this.#sessionId,
				timestamp: this.#createdAt,
				cwd: this.#cwd,
				...this.#headerExtra,
			},
			entries: [...this.#entries],
			state,
			agents,
			cursor: this.#cursor,
		};
	}
}
