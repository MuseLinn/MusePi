/**
 * GUI session store — subscribes to one daemon session and applies the
 * stream to a shared MaterializedView (from @musepi/sdk) plus the
 * streaming/active-tool state the transcript needs on top of the snapshot.
 *
 * The daemon sends `{ kind, seq, payload }` envelopes after session.subscribe
 * / session.resume. Entry-bearing payloads project straight into the view;
 * tool_execution_* events drive `activeTools`; message updates keep a
 * streaming "ghost" message until the matching entry lands in the view.
 */

import type {
	AgentEvent,
	AgentProgress,
	AgentSnapshot,
	SessionEntry,
	SessionState,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@musepi/pi-wire";
import { MaterializedView } from "@musepi/sdk";
import { dispatchNotification, documentUnfocused, type FocusReport, type NotifyContext } from "./notify";
import type { StreamEvent } from "./rpc";
import { sfxFor } from "./sfx";

/** Pet bubble kinds (伙伴): one per notification event, mapped 1:1 by the
 *  main-window bridge to the floating pet window. */
export type PetBubbleKind = "completed" | "subtask" | "error" | "question";

/** Broadcast a pet bubble (window event — app.tsx forwards it to the pet
 *  window over Electron IPC; plain browsers ignore it). `requestId` rides
 *  along for question bubbles so the pet panel can answer approvals. */
export function dispatchPetActivity(kind: PetBubbleKind, text: string, requestId?: string, sessionId?: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent("omp-pet-activity", { detail: { kind, text, requestId, sessionId } }));
}

/** Matches guest-client's ActiveTool shape (the Transcript consumes it). */
export interface ActiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partialResult?: unknown;
	startedAt: number;
}

export interface GuiSessionState {
	sessionId: string;
	entries: readonly SessionEntry[];
	state: SessionState | null;
	/** True once the assistant message of a turn has started streaming.
	 *  The transcript renders the message itself (the view folds it in at
	 *  message_start); no separate stream ghost is kept — a ghost row
	 *  beside the entry duplicated it (user: 俩 orbs and thinking). */
	streaming: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	cursor: number;
	/** Subagent visuals (details panel): snapshots, progress, lifecycle. */
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	/** Subagent ids that completed while the user was not looking at the GUI
	 *  (window hidden/unfocused at completion time). Cleared when the user
	 *  opens the agent's drawer (markAgentViewed). Ephemeral: GUI-lifetime
	 *  registry keyed by sessionId, lost on app restart. */
	unviewedCompleted: readonly string[];
	/** Pending tool approvals (approval cards above the composer). */
	approvals: readonly ApprovalRequest[];
	/** Latest idle recap (TUI parity) — cleared on any new wire activity. */
	recap: { text: string; at: number } | null;
	/** Frozen per-round totals (final assistant msg ts → ms) — each completed
	 *  round's "已工作 X 秒" stays under its final message. */
	roundDurations: ReadonlyMap<number, number>;
}

/** One pending tool approval awaiting a GUI decision. */
export interface ApprovalRequest {
	requestId: string;
	tool: string;
	/** Full approval prompt body (Allow tool / Reason / command+args) —
	 *  present on daemon >= 2026-08-20; older daemons omit it. */
	prompt?: string;
}

/** Gap-recovery hooks (roadmap M1.4). Optional: a store built without them
 *  keeps today's "apply everything" behavior — the watermark gate still
 *  skips replays, it just never reorders or recovers. */
export interface SessionGapHooks {
	/** A journal-seq gap was detected in the event stream. Request daemon
	 *  catchup from `afterSeq` (session.catchup); the replayed records flow
	 *  back through apply() and drain the reorder buffer. Resolve
	 *  `{resyncRequired: true}` when the daemon says the gap predates the
	 *  compaction checkpoint (or the watermark is divergent) — the caller
	 *  must then re-open the session (full snapshot resync). */
	onGapDetected?: (afterSeq: number) => Promise<{ resyncRequired: boolean }>;
	/** Last-resort full resync: fi	red when catchup answers resyncRequired or
	 *  a gap stays unresolved past the guard timeout. The store is replaced
	 *  by the re-open; implementations must NOT touch this store afterwards. */
	onResyncRequired?: () => void;
	/** Daemon broadcast `session_leaf_moved` (RPC session.branchAt — 撤回/
	 *  编辑/重试/branch switch moved the session tree leaf in place). The
	 *  event carries no transcript rows of its own; daemons that ship
	 *  `path`/`pathEntries` let the store re-anchor LOCALLY (see
	 *  #reanchorPath) — older daemons (or a malformed payload) fall back to
	 *  this hook: implementations re-fetch session.resume and hand it to
	 *  {@link GuiSessionStore.reloadFromSnapshot} — the store identity is
	 *  preserved so the chat view's pinned leaf and jump-back dock survive
	 *  the refresh. `leafId` is the new leaf's view key, null = moved to
	 *  the ROOT. */
	onLeafMoved?: (leafId: string | null) => void;
}

/** Gap guard: no reorder progress for this long → full resync. */
const GAP_TIMEOUT_MS = 10_000;

// ── Completed-round totals (GUI-lifetime registry) ─────────────────────────
// The store is DISPOSED and recreated on every session switch (app.tsx
// openSession), so frozen round durations live in a module-level registry
// keyed by sessionId. Seeded from the daemon snapshot (authoritative for
// rounds that completed while the GUI was switched away — the daemon records
// them at agent_end) AND from live agent_end events this store processed
// (covers rounds completed in-session even before the daemon restarts with
// the recording code). Pruned on session delete.
const roundDurationsBySession = new Map<string, Map<number, number>>();

function roundDurationsFor(sessionId: string): Map<number, number> {
	let m = roundDurationsBySession.get(sessionId);
	if (!m) {
		m = new Map();
		roundDurationsBySession.set(sessionId, m);
	}
	return m;
}

// ── Unviewed subagent completions (GUI-lifetime registry) ──────────────────
// Same lifecycle reasoning as roundDurationsBySession: the store is DISPOSED
// and recreated on every session switch (app.tsx openSession), so "completed
// while the user wasn't looking" marks live in a module-level registry keyed
// by sessionId — they survive a session switch away and back (the exact case
// the marker exists for). Ephemeral by scope: lost on app restart, never
// persisted daemon-side. Pruned on session delete via clearUnviewedCompletions.
const unviewedCompletedBySession = new Map<string, Set<string>>();

function unviewedCompletedFor(sessionId: string): Set<string> {
	let s = unviewedCompletedBySession.get(sessionId);
	if (!s) {
		s = new Set();
		unviewedCompletedBySession.set(sessionId, s);
	}
	return s;
}

/** Drop a deleted session's unviewed-completion marks (session.delete path). */
export function clearUnviewedCompletions(sessionId: string): void {
	unviewedCompletedBySession.delete(sessionId);
}

export type { FocusReport } from "./notify";
/**
 * Focus reporting now lives in `./notify` — the notification focus gate is its
 * primary consumer (issue #14). Re-exported so existing imports keep working;
 * the pure `doc` argument is what makes it testable without stubbing a global
 * `document` (a global stub changes what libraries loaded later in the same
 * process conclude about the environment — emotion captures `isBrowser` at
 * import and then requires a real `querySelectorAll`).
 */
export { documentUnfocused } from "./notify";

/** The ambient document, as {@link documentUnfocused} sees it. */
function ambientDoc(): FocusReport | undefined {
	return typeof document === "undefined" ? undefined : (document as unknown as FocusReport);
}

/** Concatenated assistant text of a message, trimmed for notify/pet payloads. */
function assistantText(
	message: { content?: ReadonlyArray<{ type?: string; text?: string }> } | undefined,
	limit = 140,
): string {
	return (message?.content ?? [])
		.filter(b => b?.type === "text")
		.map(b => b.text ?? "")
		.join(" ")
		.slice(0, limit);
}

/** Drop a deleted session's recorded totals (GUI session.delete path). */
export function clearRoundDurations(sessionId: string): void {
	roundDurationsBySession.delete(sessionId);
}

/** Round duration (ms) of a just-completed run — craft-agents parity: start
 *  = the last user message timestamp (the round's anchor), end = agent_end.
 *  Keyed by the final assistant message's timestamp so the transcript can
 *  pin the frozen total to exactly the round's last row. */
function recordRoundDuration(entries: readonly SessionEntry[]): { assistantTs: number; durationMs: number } | null {
	let userTs: number | undefined;
	let assistantTs: number | undefined;
	for (const e of entries) {
		if (e.type !== "message") continue;
		if (e.message.role === "user") userTs = e.message.timestamp;
		else if (e.message.role === "assistant") assistantTs = e.message.timestamp;
	}
	if (userTs === undefined || assistantTs === undefined) return null;
	return { assistantTs, durationMs: Date.now() - userTs };
}

export class GuiSessionStore {
	readonly #sessionId: string;
	readonly #cwd: string;
	readonly #hooks: SessionGapHooks;
	#view: MaterializedView;
	#streaming = false;
	#activeTools = new Map<string, ActiveTool>();
	#working = false;
	#agents = new Map<string, AgentSnapshot>();
	#progress = new Map<string, SubagentProgressPayload>();
	#lifecycle = new Map<string, SubagentLifecyclePayload>();
	#approvals = new Map<string, ApprovalRequest>();
	#recap: { text: string; at: number } | null = null;
	#roundDurations: Map<number, number>;
	#listeners = new Set<() => void>();
	/** 乐观回显:发送瞬间本地插入的用户消息(TUI startPendingSubmission
	 *  parity)。daemon 的 message_start 到达时按内容签名移除,由权威
	 *  entry 接管;turn 结束仍未匹配则清空(防幽灵)。 */
	#optimisticUser: { text: string; images?: { type: "image"; data: string; mimeType: string }[] } | null = null;
	#optimisticSeq = 0;
	/** Cached snapshot — `useSyncExternalStore` requires a stable reference
	 *  between mutations, so the snapshot is rebuilt only inside {@link apply}. */
	#snapshot: GuiSessionState;
	/** Frame-coalesced streaming envelopes (dsh Notifier.markFrameDirty parity):
	 *  daemon pushes per-message_update, but React only needs one render per
	 *  animation frame — the burst collapses to a single snapshot rebuild +
	 *  emit. Non-streaming envelopes (approval-request, recap) bypass this. */
	#pending: StreamEvent[] = [];
	#frameScheduled = false;
	/** Journal watermark (M1.4): last contiguously applied event seq.
	 *  Seeded from the snapshot cursor (the daemon stamps it with the
	 *  journal tail); advances only when watermark+1 is applied. */
	#watermark: number;
	/** Reorder buffer: events with seq > watermark+1 wait here (out of
	 *  order or dropped frames) until the missing seqs arrive — live or via
	 *  the catchup replay. */
	#reorder = new Map<number, StreamEvent>();
	#catchupInFlight = false;
	#gapTimer: ReturnType<typeof setTimeout> | null = null;
	#resyncTriggered = false;

	constructor(
		sessionId: string,
		snapshot: {
			entries: SessionEntry[];
			state?: SessionState;
			cursor: number;
			roundDurations?: [number, number][];
			/** Tail-window info from the daemon's initial snapshot: older
			 *  history exists beyond the loaded tail (kimi/DSH lazy paging). */
			tail?: { hasMore: boolean; beforeId: string | null };
			/** Subscribe-time hydration (daemon: running tool calls + owned
			 *  subagent progress) — stream-only visuals that never replay
			 *  from entries, so a session switch would otherwise blank the
			 *  composer dock / swarm card until the next live frame. */
			activeTools?: ActiveTool[];
			agentsProgress?: SubagentProgressPayload[];
		},
		cwd: string,
		hooks: SessionGapHooks = {},
	) {
		this.#sessionId = sessionId;
		this.#cwd = cwd;
		this.#hooks = hooks;
		this.#view =
			MaterializedView.fromSnapshot(sessionId, cwd, snapshot) ?? MaterializedView.replay(sessionId, cwd, []);
		// Merge the daemon-recorded totals (rounds completed while this
		// session was not subscribed) into the GUI-lifetime registry.
		const merged = roundDurationsFor(sessionId);
		for (const [ts, ms] of snapshot.roundDurations ?? []) merged.set(ts, ms);
		this.#roundDurations = merged;
		this.#hasMore = snapshot.tail?.hasMore === true;
		this.#beforeId = snapshot.tail?.beforeId ?? null;
		// Mid-run join (resume while the agent works): the daemon snapshot's
		// authoritative isStreaming seeds the run flag — live turn events
		// maintain it and state frames correct it.
		this.#working = snapshot.state?.isStreaming === true;
		// Hydration seeds (see snapshot type): same projection the live
		// agent-progress / tool_execution envelopes use, applied directly so
		// no notifications or sound effects fire on re-subscribe.
		for (const tool of snapshot.activeTools ?? []) {
			this.#activeTools.set(tool.toolCallId, { ...tool });
		}
		for (const wrapper of snapshot.agentsProgress ?? []) {
			this.#upsertSubagentProgress(wrapper);
		}
		this.#watermark = typeof snapshot.cursor === "number" && Number.isInteger(snapshot.cursor) ? snapshot.cursor : 0;
		this.#snapshot = this.#buildSnapshot();
	}

	/** Tail-window state: older history exists beyond the loaded tail. */
	#hasMore = false;
	/** Oldest loaded entry id — the session.history cursor. */
	#beforeId: string | null = null;

	/** True while the daemon still has history older than the loaded tail. */
	get hasMore(): boolean {
		return this.#hasMore;
	}

	/** session.history cursor for the next older page (null = exhausted). */
	get historyBeforeId(): string | null {
		return this.#beforeId;
	}

	/**
	 * Prepend an older page (lazy backfill on scroll-up): the caller
	 * fetched session.history with historyBeforeId; remaining = how many
	 * older entries still exist beyond this page (re-arms the cursor).
	 */
	prependEntries(older: readonly SessionEntry[], remaining: number): void {
		if (older.length === 0) return;
		// Overlap pages (ambiguous beforeId on duplicated journal ids) return
		// null and must NOT advance the cursor — the oldest held id stays the
		// pagination anchor.
		const firstFresh = this.#view.prependEntries(older);
		if (firstFresh !== null) this.#beforeId = firstFresh;
		this.#hasMore = remaining > 0 && this.#beforeId !== null;
		this.#snapshot = this.#buildSnapshot();
		this.#emit();
	}

	/**
	 * Local re-anchor after a daemon `session_leaf_moved` that ships
	 * `pathEntries` (additive daemon contract): fold the new active path
	 * into the CURRENT view instead of replacing it. Unlike
	 * reloadFromSnapshot — which swaps the whole view for a fresh
	 * session.resume (the newest TAIL window) — this keeps every row the
	 * store already materialized: sibling branches and the rewound-away
	 * tail stay visible on the map / trajectory, and the transcript filter
	 * (ChatView's pinned path) decides what shows. Only path rows missing
	 * from the loaded window get prepended (older-than-tail rewinds);
	 * prependEntries dedupes by id and advances the history cursor, so a
	 * subsequent scroll-up backfill stays consistent. The event was
	 * admitted through the watermark gate before #applyNow ran, so
	 * #watermark already covers it; pending/reorder frames with seqs ≤ it
	 * are inside the folded rows by construction. Snapshot rebuild + emit
	 * are owned by the caller (flush). */
	#reanchorPath(pathEntries: SessionEntry[]): void {
		if (this.#resyncTriggered) return;
		const firstFresh = this.#view.prependEntries(pathEntries);
		if (firstFresh !== null) this.#beforeId = firstFresh;
	}

	/**
	 * Whole-snapshot refresh (session_leaf_moved path): swap the view for a
	 * freshly fetched daemon snapshot and re-align the journal watermark to
	 * its cursor. The cursor IS the journal tail at snapshot time, so every
	 * frame already applied is reflected in the fresh entries — replays
	 * (catchup overlap, frames still in flight) at seqs ≤ the new watermark
	 * are dropped as the duplicates they now are, and nothing between the old
	 * watermark and the cursor can go missing. Store identity is preserved:
	 * listeners, the chat view's pinned leaf and the jump-back dock all
	 * survive the refresh (a full openSession would tear them down). No-op
	 * after a resync trigger — that store was already replaced.
	 */
	reloadFromSnapshot(snapshot: {
		entries: SessionEntry[];
		state?: SessionState;
		cursor: number;
		roundDurations?: [number, number][];
		tail?: { hasMore: boolean; beforeId: string | null };
	}): void {
		if (this.#resyncTriggered) return;
		this.#view =
			MaterializedView.fromSnapshot(this.#sessionId, this.#cwd, snapshot) ??
			MaterializedView.replay(this.#sessionId, this.#cwd, []);
		const merged = roundDurationsFor(this.#sessionId);
		for (const [ts, ms] of snapshot.roundDurations ?? []) merged.set(ts, ms);
		this.#roundDurations = merged;
		this.#hasMore = snapshot.tail?.hasMore === true;
		this.#beforeId = snapshot.tail?.beforeId ?? null;
		// Mid-run refresh: the daemon snapshot's authoritative isStreaming
		// seeds the run flag, exactly like the constructor (live turn events
		// maintain it and state frames correct it).
		this.#working = snapshot.state?.isStreaming === true;
		this.#watermark = typeof snapshot.cursor === "number" && Number.isInteger(snapshot.cursor) ? snapshot.cursor : 0;
		// Frames admitted before the refresh (pending burst / reorder buffer)
		// are inside the snapshot cursor by construction — re-applying them
		// onto the fresh view would duplicate append-only entries (thinking
		// levels, custom messages).
		this.#pending = [];
		this.#reorder.clear();
		this.#clearGapTimer();
		this.#snapshot = this.#buildSnapshot();
		this.#emit();
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	/** Notification template context (Settings → 通知与音效): resolved from
	 *  the live snapshot at event time; per-event extras override. */
	#notifyCtx(extra: NotifyContext): NotifyContext {
		const state = this.#view.snapshot().state;
		const main = [...this.#agents.values()].find(a => a.kind === "main");
		const slash = this.#cwd.lastIndexOf("/");
		return {
			projectName: slash >= 0 ? this.#cwd.slice(slash + 1) : this.#cwd,
			sessionName: state?.sessionName,
			agentName: main?.displayName,
			modelName: state?.model ? state.model.name || state.model.id : undefined,
			...extra,
		};
	}

	/** Session workspace root — composer "@" completion scope. */
	get cwd(): string {
		return this.#cwd;
	}

	/** User-dismissed the idle recap (× on the row) — cleared, not re-armed. */
	dismissRecap(): void {
		if (!this.#recap) return;
		this.#recap = null;
		this.#snapshot = this.#buildSnapshot();
		this.#emit();
	}

	/**
	 * 乐观回显:发送后立即把用户消息插入本地视图,不等 daemon 事件流
	 * 回推(TUI startPendingSubmission parity)。daemon 的 user
	 * message_start 到达时按内容签名匹配并移除,由权威 entry 接管。
	 * turn 结束(agent_end)仍未匹配则清空——发送失败/被吞时不留幽灵。
	 */
	optimisticEcho(text: string, images?: { type: "image"; data: string; mimeType: string }[]): void {
		this.#optimisticUser = { text, images };
		this.#optimisticSeq += 1;
		this.#snapshot = this.#buildSnapshot();
		this.#emit();
	}

	/** 乐观条目内容签名(与 daemon message_start 比对)。 */
	#optimisticSignature(): string {
		const o = this.#optimisticUser;
		if (!o) return "";
		return `${o.text}\u0000${o.images?.length ?? 0}`;
	}

	/** 移除乐观回显(权威条目已接管 / turn 结束清理)。 */
	#clearOptimisticUser(): void {
		if (!this.#optimisticUser) return;
		this.#optimisticUser = null;
		this.#snapshot = this.#buildSnapshot();
		this.#emit();
	}

	getSnapshot(): GuiSessionState {
		return this.#snapshot;
	}

	#buildSnapshot(): GuiSessionState {
		const snap = this.#view.snapshot();
		// 乐观回显条目:发送瞬间本地插入的用户消息,追加在 entries 尾部
		// (daemon 权威 message_start 到达后 #applyNow 清除)。
		let entries = snap.entries;
		if (this.#optimisticUser) {
			const o = this.#optimisticUser;
			const optimisticEntry: SessionEntry = {
				type: "message",
				// 本地唯一 id(与 daemon 的 user:timestamp 空间隔离,绝不去重冲突)。
				id: `user:optimistic-${this.#optimisticSeq}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "user",
					timestamp: Date.now(),
					content: [...(o.text ? [{ type: "text" as const, text: o.text }] : []), ...(o.images ?? [])],
				},
			};
			entries = [...entries, optimisticEntry];
		}
		return {
			sessionId: this.#sessionId,
			entries,
			state: snap.state,
			streaming: this.#streaming,
			activeTools: this.#activeTools,
			// Single source of truth: #working spans the WHOLE run
			// (agent_start→agent_end, seeded from resume snapshots,
			// corrected by authoritative state frames). Never OR in the
			// view's turn-level isStreaming — it can go stale on an abort
			// without turn_end and would pin the stop capsule on forever.
			working: this.#working,
			cursor: snap.cursor,
			agents: [...this.#agents.values()],
			progress: this.#progress,
			lifecycle: this.#lifecycle,
			unviewedCompleted: [...unviewedCompletedFor(this.#sessionId)],
			approvals: [...this.#approvals.values()],
			recap: this.#recap,
			roundDurations: this.#roundDurations,
		};
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	/** Apply one daemon stream envelope. Non-streaming envelopes (approvals,
	 *  recap, resume snapshots) apply synchronously — they carry UI-critical
	 *  state. Streaming AgentEvents (message_*, tool_*, turn_*, agent_*) are
	 *  frame-coalesced: the burst collapses to one snapshot rebuild + emit
	 *  per animation frame (dsh Notifier.markFrameDirty parity).
	 *
	 *  Journal-seq'd kind:"event" envelopes (seq > 0) pass the M1.4
	 *  watermark gate first: replays (seq ≤ watermark) are dropped, gaps
	 *  (seq > watermark+1) buffer in #reorder and trigger daemon catchup.
	 *  Envelopes without a journal seq (0 / legacy / non-event kinds) apply
	 *  ungated — they live outside the watermark space. */
	apply(event: StreamEvent): void {
		if (event.kind === "approval-request" || event.kind === "recap") {
			this.#applyNow(event);
			this.#emit();
			return;
		}
		const payload = event.payload as AgentEvent | undefined;
		if (!payload || typeof payload !== "object") {
			// Non-AgentEvent envelopes (state snapshots from resume etc.) are
			// already folded into the snapshot by the daemon — nothing to do.
			this.#emit();
			return;
		}
		if (event.kind === "event" && Number.isInteger(event.seq) && event.seq > 0) {
			if (!this.#admitSeq(event)) return;
			this.#scheduleFlush();
			return;
		}
		this.#pending.push(event);
		this.#scheduleFlush();
	}

	/** Watermark gate (M1.4). Returns true when the event was admitted
	 *  (pushed to #pending, possibly draining the reorder buffer behind it);
	 *  false when it was dropped (replay) or buffered (gap → catchup). */
	#admitSeq(event: StreamEvent): boolean {
		const seq = event.seq;
		if (seq <= this.#watermark) {
			// Catchup overlap or a replayed frame: already reflected in the
			// view — re-applying would duplicate transcript entries.
			return false;
		}
		if (seq > this.#watermark + 1) {
			// Hole in the stream (dropped frame / reconnect race): hold the
			// event in order and ask the daemon for everything after the
			// watermark. Never apply past a hole — the transcript must not
			// show state built on missing frames.
			this.#reorder.set(seq, event);
			this.#requestCatchup();
			return false;
		}
		this.#watermark = seq;
		this.#pending.push(event);
		// Strict in-order drain: the buffer (and any catchup replay flowing
		// back through apply) only lands contiguously from watermark+1 up.
		while (this.#reorder.has(this.#watermark + 1)) {
			const next = this.#reorder.get(this.#watermark + 1);
			this.#reorder.delete(this.#watermark + 1);
			if (next) {
				this.#watermark += 1;
				this.#pending.push(next);
			}
		}
		if (this.#reorder.size === 0) this.#clearGapTimer();
		return true;
	}

	/** Gap detected: arm the resync guard and ask the daemon for a catchup
	 *  replay (deduped — one in-flight request at a time). No retry loop
	 *  here: replayed records flow back through apply() and re-trigger this
	 *  if they expose a further hole; a gap nobody fills escalates via the
	 *  guard timer instead of spamming the daemon. */
	#requestCatchup(): void {
		this.#armGapTimer();
		if (this.#catchupInFlight) return;
		const onGapDetected = this.#hooks.onGapDetected;
		if (!onGapDetected) return;
		this.#catchupInFlight = true;
		onGapDetected(this.#watermark)
			.then(result => {
				if (result?.resyncRequired) this.#triggerResync();
			})
			.catch(() => {
				// Catchup RPC failed: no progress. The gap timer escalates
				// to a full resync — do not tight-loop retries here.
			})
			.finally(() => {
				this.#catchupInFlight = false;
			});
	}

	#armGapTimer(): void {
		if (this.#gapTimer !== null || this.#resyncTriggered) return;
		this.#gapTimer = setTimeout(() => {
			this.#gapTimer = null;
			if (this.#reorder.size > 0) this.#triggerResync();
		}, GAP_TIMEOUT_MS);
		this.#gapTimer.unref?.();
	}

	#clearGapTimer(): void {
		if (this.#gapTimer !== null) {
			clearTimeout(this.#gapTimer);
			this.#gapTimer = null;
		}
	}

	/** Unrecoverable gap (compaction swallowed it, or the guard timed out):
	 *  the only honest recovery is a full snapshot re-subscribe. The caller
	 *  replaces this store — afterwards this instance only answers skips. */
	#triggerResync(): void {
		if (this.#resyncTriggered) return;
		this.#resyncTriggered = true;
		this.#clearGapTimer();
		try {
			this.#hooks.onResyncRequired?.();
		} catch {
			// The resync hook must never take the store down with it.
		}
	}

	/** Frame-coalesce: collapse the pending burst to one flush per frame. */
	#scheduleFlush(): void {
		if (this.#frameScheduled) return;
		this.#frameScheduled = true;
		const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
		if (typeof raf === "function") {
			raf(() => this.#flush());
		} else {
			queueMicrotask(() => this.#flush());
		}
	}

	#flush(): void {
		this.#frameScheduled = false;
		const batch = this.#pending;
		this.#pending = [];
		if (batch.length === 0) return;
		// Coalesce consecutive message_update envelopes of the same assistant
		// message: only the latest cumulative payload matters (wire messages
		// carry full state, no deltas).
		const collapsed: StreamEvent[] = [];
		for (const ev of batch) {
			const prev = collapsed[collapsed.length - 1];
			if (
				prev &&
				(prev.payload as AgentEvent | undefined)?.type === "message_update" &&
				(ev.payload as AgentEvent | undefined)?.type === "message_update" &&
				(prev.payload as { message?: { timestamp?: unknown } }).message?.timestamp ===
					(ev.payload as { message?: { timestamp?: unknown } }).message?.timestamp
			) {
				collapsed[collapsed.length - 1] = ev;
			} else {
				collapsed.push(ev);
			}
		}
		for (const ev of collapsed) this.#applyNow(ev);
		this.#snapshot = this.#buildSnapshot();
		this.#emit();
	}

	/** Project one SubagentProgressPayload into #progress + #agents (the
	 *  live agent-progress path AND the subscribe-time hydration seed share
	 *  it). Returns false when the payload is malformed. No notifications,
	 *  no snapshot rebuild — callers own both. */
	#upsertSubagentProgress(wrapper: SubagentProgressPayload): boolean {
		const p = wrapper?.progress as AgentProgress | undefined;
		if (!wrapper || !p || typeof p.id !== "string") return false;
		this.#progress.set(p.id, wrapper);
		// The daemon attaches the subagent's session file to the progress
		// envelope (task/executor emits it with every frame); hasSessionFile
		// gates the SubagentPanel transcript polling, so it must land on the
		// snapshot. Upgrade-only on existing rows: a session file, once
		// created, never goes away.
		const hasSessionFile = wrapper.sessionFile != null;
		const existing = this.#agents.get(p.id);
		if (existing) {
			existing.status = p.status === "running" ? "running" : "idle";
			existing.lastActivity = Date.now();
			if (hasSessionFile) existing.hasSessionFile = true;
			this.#agents.set(p.id, existing);
		} else {
			// First sight of a subagent: synthesize its AgentSnapshot (the
			// daemon stream carries progress but no per-subagent start
			// envelope, so the row appears from the first progress frame).
			this.#agents.set(p.id, {
				id: p.id,
				displayName: p.agent,
				kind: "sub",
				parentId: undefined,
				status: p.status === "running" ? "running" : "idle",
				hasSessionFile,
				createdAt: Date.now(),
				lastActivity: Date.now(),
			});
		}
		return true;
	}

	/** Core envelope handling: state mutations + materialized view fold. */
	#applyNow(event: StreamEvent): void {
		// Authoritative state frames (daemon rebroadcast after revert/abort
		// and the like): the event-driven #working flag can go stale when a
		// turn is aborted without a turn_end — apply isStreaming whenever a
		// state frame arrives so the stop button / thinking line never stay
		// stuck on a phantom working turn.
		if (event.kind === "state") {
			const p = event.payload as { isStreaming?: unknown } | null;
			if (typeof p?.isStreaming === "boolean") {
				this.#working = p.isStreaming;
				if (!p.isStreaming) this.#streaming = false;
			}
			this.#snapshot = this.#buildSnapshot();
			this.#emit();
			return;
		}
		// Pending tool approvals — the GUI answers via tool.approve / tool.deny.
		if (event.kind === "approval-request") {
			const p = event.payload as { requestId?: unknown; tool?: unknown; prompt?: unknown };
			if (typeof p?.requestId === "string") {
				this.#approvals.set(p.requestId, {
					requestId: p.requestId,
					tool: typeof p.tool === "string" ? p.tool : "unknown",
					prompt: typeof p.prompt === "string" ? p.prompt : undefined,
				});
				// The agent is asking the user a question (approval request).
				dispatchNotification(
					"question",
					this.#notifyCtx({ lastMessage: typeof p.tool === "string" ? p.tool : undefined }),
				);
				dispatchPetActivity("question", typeof p.tool === "string" ? p.tool : "", p.requestId);
				this.#snapshot = this.#buildSnapshot();
				this.#emit();
			}
			return;
		}
		// Non-AgentEvent envelopes: subagent visuals + terminal state.
		if (event.kind === "stream-end") {
			this.#emit();
			return;
		}
		if (event.kind === "agent-lifecycle") {
			const p = event.payload as SubagentLifecyclePayload;
			// Cross-session guard (client half of the daemon's ownership
			// routing): a frame tagged for another session must never paint
			// this session's swarm visuals.
			if (p.sessionId !== undefined && p.sessionId !== this.#sessionId) return;
			if (p.status === "completed") {
				// Completed while the user wasn't looking → keep the marker so
				// the Agents Center row shows it as unviewed until opened.
				// Focus check happens here (event arrival), NOT at render:
				// the daemon drops the lifecycle frame after this branch, so
				// the completion fact is only observable at this instant.
				if (documentUnfocused(ambientDoc())) unviewedCompletedFor(this.#sessionId).add(p.id);
				// Sub-agent finished — notify before the frames are dropped.
				dispatchNotification(
					"subtask",
					this.#notifyCtx({ agentName: p.agent, lastMessage: p.description ?? p.agent }),
				);
				dispatchPetActivity("subtask", p.description ?? p.agent);
			}
			this.#lifecycle.set(p.id, p);
			// The lifecycle envelope carries the authoritative session file —
			// upgrade the row's hasSessionFile so the SubagentPanel can fetch
			// the transcript even when the agent's progress frames never
			// carried one (or the file exists from the start). Terminal frame
			// cleanup below drops progress/lifecycle; the #agents row and its
			// hasSessionFile flag survive so the completed-subagent drawer
			// still reads the transcript.
			const lifecycleRow = this.#agents.get(p.id);
			if (lifecycleRow && p.sessionFile != null) {
				lifecycleRow.hasSessionFile = true;
				this.#agents.set(p.id, lifecycleRow);
			}
			// Terminal lifecycle: the progress/lifecycle frames are process
			// data for live visuals — without this, long sessions keep one
			// entry per finished subagent forever. The #agents row stays
			// (the panel shows completed subagent history), bounded by the
			// number of subagents rather than their progress frames.
			if (p.status !== "started") {
				this.#progress.delete(p.id);
				this.#lifecycle.delete(p.id);
			} else {
				// Revival / fresh run of a previously marked id: the old
				// "completed-unviewed" fact no longer holds — drop the stale
				// marker so the row can't show "新" while the agent re-runs.
				unviewedCompletedFor(this.#sessionId).delete(p.id);
			}
			this.#snapshot = this.#buildSnapshot();
			this.#emit();
			return;
		}
		if (event.kind === "agent-progress") {
			// The stream carries the EventBus wrapper (SubagentProgressPayload);
			// the AgentProgress lives inside it. AgentsPanel consumes the
			// wrapper shape, keyed by the subagent id.
			const wrapper = event.payload as SubagentProgressPayload;
			if (wrapper.sessionId !== undefined && wrapper.sessionId !== this.#sessionId) return;
			if (!this.#upsertSubagentProgress(wrapper)) {
				this.#emit();
				return;
			}
			this.#snapshot = this.#buildSnapshot();
			this.#emit();
			return;
		}
		// Idle recap (daemon recap.enabled parity): the latest summary text, kept
		// until the next wire activity supersedes it.
		if (event.kind === "recap") {
			const p = event.payload as { text?: unknown; at?: unknown };
			if (typeof p?.text === "string") {
				this.#recap = { text: p.text, at: typeof p.at === "number" ? p.at : Date.now() };
				this.#snapshot = this.#buildSnapshot();
				this.#emit();
			}
			return;
		}
		const payload = event.payload as AgentEvent | undefined;
		if (!payload || typeof payload !== "object") {
			// Non-AgentEvent envelopes (state snapshots from resume etc.) are
			// already folded into the snapshot by the daemon — nothing to do.
			this.#emit();
			return;
		}
		const ev = payload as AgentEvent;
		switch (ev.type) {
			case "message_start": {
				// The view folds the assistant message into entries right here
				// (message_start), so no stream ghost is kept — a separate ghost
				// row rendered beside the entry duplicated the message while
				// streaming (user: two identical rows, both with orb + 思考).
				if (ev.message.role === "assistant") this.#streaming = true;
				// The user's own message (optimistic emit — arrives ~30ms after
				// send) marks the turn as working immediately, so the indicator
				// never lags the bubble: agent_start / turn_start can be seconds
				// away (auto-thinking classification + provider prep). turn_end /
				// agent-end state frames reset it.
				else if (ev.message.role === "user") {
					this.#working = true;
					// 乐观回显接管:daemon 的 user message_start 到达 → 按内容
					// 签名匹配本地乐观条目 → 移除,由权威 entry 渲染(签名
					// 不匹配说明是历史/他处消息,乐观条目留待 turn 结束清理)。
					const m = ev.message;
					const text =
						typeof m.content === "string"
							? m.content
							: (m.content ?? [])
									.filter(c => c.type === "text")
									.map(c => (c.type === "text" ? c.text : ""))
									.join("");
					const imageCount = Array.isArray(m.content) ? m.content.filter(c => c.type === "image").length : 0;
					if (this.#optimisticUser && this.#optimisticSignature() === `${text}\u0000${imageCount}`) {
						this.#clearOptimisticUser();
					}
				}
				break;
			}
			case "message_update": {
				// Entry updates flow through the view (immutable upsert), so the
				// transcript row re-renders with the streamed content directly.
				break;
			}
			case "message_end": {
				// Final message folds into the view like any update. A finished
				// assistant text reply (no pending tool call) = turn completion.
				const m = ev.message;
				if (m.role === "assistant") {
					const blocks = m.content;
					const hasText = blocks.some(b => b.type === "text");
					const hasTools = blocks.some(b => b.type === "toolCall");
					if (hasText && !hasTools) {
						// NOTE: no completion NOTIFICATION here any more (issue
						// #14) — a run that used tools ended with no toast at
						// all, and a text-only reply double-fired with
						// agent_end. Completion is dispatched once at
						// agent_end; the pet activity still trails the reply.
						const text = assistantText(m);
						dispatchPetActivity("completed", text, undefined, this.#sessionId);
					}
				}
				break;
			}
			case "tool_execution_start": {
				const t = ev as {
					type: "tool_execution_start";
					toolCallId: string;
					toolName: string;
					args: unknown;
					intent?: string;
				};
				this.#activeTools.set(t.toolCallId, {
					toolCallId: t.toolCallId,
					toolName: t.toolName,
					args: t.args,
					intent: t.intent,
					startedAt: Date.now(),
				});
				break;
			}
			case "tool_execution_update": {
				const t = ev as {
					type: "tool_execution_update";
					toolCallId: string;
					args: unknown;
					partialResult: unknown;
				};
				const existing = this.#activeTools.get(t.toolCallId);
				if (existing) {
					existing.args = t.args ?? existing.args;
					existing.partialResult = t.partialResult;
					this.#activeTools.set(t.toolCallId, existing);
				}
				break;
			}
			case "tool_execution_end": {
				const t = ev as { type: "tool_execution_end"; toolCallId: string; isError?: boolean };
				const toolName = this.#activeTools.get(t.toolCallId)?.toolName;
				this.#activeTools.delete(t.toolCallId);
				// Tool result arrived — soft tick (effects prefs gate it).
				sfxFor("tool");
				if (t.isError) {
					// Tool-call errors no longer fire system notifications or
					// pet bubbles (user-visible popups), but the error sound
					// stays audible so the failure is still heard.
					sfxFor("error");
				}
				break;
			}
			case "turn_start":
			case "agent_start":
				// A run is live from its first model call until agent_end.
				// turn_end fires per tool batch INSIDE one run — clearing
				// #working there flipped the composer's stop capsule back
				// to the send arrow during provider prep between rounds
				// (user report). Only agent_end / authoritative state
				// frames end a run.
				this.#working = true;
				break;
			case "turn_end":
				// Mid-run boundary: streaming pauses, the run does not.
				this.#streaming = false;
				break;
			case "agent_end": {
				// Agent run finished (opencode turn-complete parity): the
				// "ready" cue — once per run, NOT per model-call turn
				// (turn_end fires per tool batch inside one run). Aborted
				// runs get the stop cue instead; errors have their own.
				// Run truly over — this (not turn_end) retires the stop
				// capsule; aborted runs rely on the stopReason frame below.
				this.#working = false;
				this.#streaming = false;
				// Run 结束:乐观回显仍未匹配(daemon 没回推同名 user 消息)
				// → 发送被吞/失败,清掉本地幽灵,不留占位。
				if (this.#optimisticUser) this.#clearOptimisticUser();
				const t = ev as {
					type: "agent_end";
					messages?: Array<{
						role?: string;
						stopReason?: string;
						content?: ReadonlyArray<{ type?: string; text?: string }>;
					}>;
				};
				const last = [...(t.messages ?? [])].reverse().find(m => m.role === "assistant");
				const stopReason = last?.stopReason;
				if (stopReason !== "aborted" && stopReason !== "error") {
					sfxFor("complete");
					// One desktop completion toast per finished run (issue
					// #14). `silent` because the cue just played: the sound
					// must survive the notification master switch being off.
					dispatchNotification("completion", this.#notifyCtx({ lastMessage: assistantText(last) }), {
						silent: true,
					});
				}
				// Freeze this run's total into the GUI-lifetime registry: the
				// store is recreated on every session switch, so without this
				// the totals would die with the disposed instance. (The daemon
				// records the same at agent_end in its own view — the registry
				// covers the window before a daemon restart picks that up.)
				const rec = recordRoundDuration(this.#view.snapshot().entries);
				if (rec) this.#roundDurations.set(rec.assistantTs, rec.durationMs);
				break;
			}
			case "session_leaf_moved": {
				// Daemon broadcast after RPC session.branchAt (撤回/编辑/重试/
				// branch switch): the session tree leaf moved IN PLACE, so the
				// daemon's active path — the thing the transcript is supposed
				// to render — changed without any entry being appended.
				// Newer daemons ship `pathEntries`: the active path in view-key
				// space. Re-anchor LOCALLY by folding those rows into the
				// current view — a session.resume re-fetch only returns the
				// newest TAIL window, so on long sessions it handed back the
				// tail we just rewound away from (撤回 looked like a no-op).
				// Rows the store already holds are deduped by id; siblings /
				// the dropped tail stay in the view (the map still shows them
				// as a branch). Older daemons without pathEntries degrade to
				// the onLeafMoved hook (session.resume re-fetch).
				const lm = ev as {
					leafId?: unknown;
					path?: unknown;
					pathEntries?: unknown;
				};
				if (Array.isArray(lm.pathEntries)) {
					// Empty array = rewound to the session root (active path is
					// empty): nothing to fold, but the contract IS supported —
					// skip the session.resume re-fetch below.
					if (lm.pathEntries.length > 0) this.#reanchorPath(lm.pathEntries as SessionEntry[]);
					break;
				}
				const leafId = lm.leafId;
				this.#hooks.onLeafMoved?.(typeof leafId === "string" ? leafId : null);
				break;
			}
			default:
				break;
		}
		// Any new wire activity supersedes the idle recap (TUI parity).
		this.#recap = null;
		this.#view.apply(ev);
		// NOTE: snapshot rebuild + emit are owned by the caller — the
		// synchronous apply() path emits once, the frame flush emits once
		// per animation frame after folding the whole batch.
	}

	dispose(): void {
		this.#clearGapTimer();
		this.#listeners.clear();
	}

	/** Remove a resolved/denied approval from the pending set. */
	dismissApproval(requestId: string): void {
		if (this.#approvals.delete(requestId)) {
			this.#snapshot = this.#buildSnapshot();
			this.#emit();
		}
	}

	/** Clear a subagent's unviewed-completed marker (user opened its drawer /
	 *  actively looked at its row). No-op when the id was never marked. */
	markAgentViewed(agentId: string): void {
		const unviewed = unviewedCompletedFor(this.#sessionId);
		if (unviewed.delete(agentId)) {
			this.#snapshot = this.#buildSnapshot();
			this.#emit();
		}
	}
}
