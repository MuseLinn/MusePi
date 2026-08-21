/**
 * Materialized session view — the projection layer of the daemon's
 * event-sourcing pipeline (daemon Phase 3), shared with browser
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
	#entries: SessionEntry[] = [];
	#mainAgent: AgentSnapshot | null = null;
	#isStreaming = false;
	// Extra header fields (user-picked model/thinking/title for history
	// sessions) survive the round-trip: snapshot() re-emits them.
	readonly #headerExtra: { title?: string; model?: string; thinkingLevel?: string } = {};
	/** Completed-round totals: final assistant message ts → duration ms,
	 *  recorded at agent_end (the round spans the last user message to the
	 *  run's end — craft-agents completedAt-freeze parity). Survives the
	 *  persisted-snapshot round-trip, so the GUI recreated on a session
	 *  switch still shows every completed round's "已工作/用时 X 秒". */
	#roundDurations = new Map<number, number>();

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

	/** Seed completed-round totals into a rebuilt view (truncate/restore
	 *  rebuild the projection from a journal replay, which never records
	 *  durations — rounds that predate the operation keep their totals). */
	seedRoundDurations(pairs: readonly (readonly [number, number])[] | undefined): void {
		if (!pairs) return;
		for (const pair of pairs) {
			if (Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && Number.isInteger(pair[1])) {
				this.#roundDurations.set(pair[0] as number, pair[1] as number);
			}
		}
	}

	/** Build a view by replaying journal records (startup / recovery path).
	 *  Round durations are NOT recorded during replay: agent_end's wall-clock
	 *  delta would be computed at replay time (a completed round from hours
	 *  ago would show a garbage total). Persisted snapshots carry the
	 *  authoritative durations; a replayed view simply has none. */
	static replay(
		sessionId: string,
		cwd: string,
		events: AgentEvent[],
		createdAt?: string,
		recordRoundDurations = false,
	): MaterializedView {
		const view = new MaterializedView(sessionId, cwd, createdAt);
		for (const event of events) view.apply(event, { recordRoundDurations });
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
		if (Array.isArray(snap.roundDurations)) {
			for (const pair of snap.roundDurations) {
				if (Array.isArray(pair) && pair.length === 2 && Number.isInteger(pair[0]) && Number.isInteger(pair[1])) {
					view.#roundDurations.set(pair[0] as number, pair[1] as number);
				}
			}
		}
		return view;
	}

	/** Incrementally project one wire event. Must be called in journal seq order. */
	apply(event: AgentEvent, options?: { recordRoundDurations?: boolean }): void {
		const recordRoundDurations = options?.recordRoundDurations !== false;
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
				// Freeze this run's total (craft-agents completedAt parity): the
				// round spans the LAST user message (its timestamp is the round
				// anchor the transcript ticks from) to agent_end; pinned to the
				// final assistant message so its row shows the frozen total.
				// Recorded in the view so the daemon persists it and any client
				// that (re)builds a view from the snapshot gets every total —
				// including rounds that completed while the GUI was switched away.
				let userTs: number | undefined;
				let assistantTs: number | undefined;
				for (const entry of this.#entries) {
					if (entry.type !== "message") continue;
					if (entry.message.role === "user") userTs = entry.message.timestamp;
					else if (entry.message.role === "assistant") assistantTs = entry.message.timestamp;
				}
				if (recordRoundDurations && userTs !== undefined && assistantTs !== undefined) {
					this.#roundDurations.set(assistantTs, Date.now() - userTs);
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
			// 向前兼容:wire message 携带 parentId(会话内条目树,/tree 语义)时
			// 原样保留;今天的 live 事件不含该字段 → null(历史快照/旧版
			// transcript 路径已带真实 parentId,从快照恢复时原样保留)。
			parentId: message.parentId ?? null,
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

	/**
	 * Prepend an older page of entries (lazy history backfill — kimi/DSH
	 * parity): the GUI opens a tail-windowed snapshot and pages older
	 * history in as the user scrolls up. `older` is oldest→newest; loaded
	 * messages are re-keyed so streamed updates to them still upsert.
	 * The view stays a plain full projection of whatever has been loaded —
	 * nothing is ever folded or evicted.
	 */
	prependEntries(older: readonly SessionEntry[]): void {
		if (older.length === 0) return;
		for (const e of older) {
			// Key exactly like #upsertMessage (messageKey, not entry.id) so a
			// streamed update to a backfilled message still replaces it.
			if (e.type === "message") this.#messages.set(messageKey(e.message), e);
		}
		this.#entries = [...older, ...this.#entries];
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
			roundDurations: [...this.#roundDurations],
		};
	}
}
