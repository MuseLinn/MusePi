/**
 * M1 turn render units — the pure projection layer behind the transcript
 * redesign (design doc: docs/review/0.5.0-m1-transcript-design.md, approved
 * 2026-09-21). ZCode `conversationTurnRenderUnits` semantics adapted to our
 * wire model: a turn is a user prompt (or a displayed advisor note, see
 * round-collapse.isTurnStart) through the row before the next turn start.
 *
 * This module owns NO React and NO fold state — it answers three questions
 * the render layer must not re-derive per row:
 *
 *   1. Which turn does each entry belong to, and where is the turn's reply
 *      (latestAssistantTextRow), work rows, tail rows and hook rows?
 *      → buildTurnRenderUnits / classifyTranscriptRow
 *   2. Is an interactive question still awaiting the user?
 *      → hasPendingAsk (an `ask` toolCall with no matching toolResult)
 *   3. Should the chat-level loading indicator be visible right now?
 *      → shouldShowChatLoading (design doc §B judgment table: pending
 *      approval / question / compaction / goalVerifier each suppress it)
 *
 * Grounding notes (verified against client-core 2026-09-21):
 *  - Approvals are HOST-side only — `approvalRequest` is always null on the
 *    guest transport, so the caller passes the flag from client state.
 *  - `ask` is a regular tool (tool-render/tools/ask.tsx); pending-ness is
 *    structural, not a separate event.
 *  - Compaction surfaces as `auto_compaction_start/end` EVENTS (client.ts
 *    turns them into notices); the caller tracks the in-between boolean.
 *  - Hooks: coding-agent HAS a full hooks engine (src/extensibility/hooks/,
 *    event set incl. Agent/Session/AutoCompaction/before_* cancellable) and
 *    the TUI tags hook messages with a hook glyph. Hook messages persist as
 *    custom_message entries whose customType is the HOOK-AUTHOR-DEFINED
 *    free-form string (examples: "file-trigger", "handoff"); nothing enforces
 *    a prefix on the wire. This classifier therefore keys on the project's
 *    existing hook namespace convention — the hook capability already names
 *    extension ids `hook:<type>:<tool>:<name>` — so hook rows are customType
 *    `hook` or `hook:*`. Enforcing that prefix on hook customTypes is an M2
 *    capability-seam item, not M1.
 */

import type { SessionEntry } from "@musepi/pi-wire";
import { isTurnStart } from "./round-collapse";
import { classifyTranscriptRow } from "./row-kinds";

export { classifyTranscriptRow, type TranscriptRowKind } from "./row-kinds";

/** One turn's render-unit projection. All indexes are absolute entry indexes
 *  into the entries array the unit was built from. */
export interface TurnRenderUnit {
	/** Stable key for list reconciliation: the turn-start entry id when it
	 *  has one, else a positional fallback. */
	key: string;
	/** 0-based ordinal among turns (design doc turn header 序号). */
	turnIndex: number;
	/** Absolute index of the turn-start entry (user prompt / advisor note). */
	startIdx: number;
	/** Absolute index of the turn's LAST row (inclusive) — the turn runs to
	 *  the row before the next turn start (openchamber turn model, same as
	 *  round-collapse). */
	endIdx: number;
	/** Absolute index of the turn's reply — the LAST assistant row carrying
	 *  non-empty text (strict: no tool-only fallback). -1 when the turn has
	 *  no reply yet (in-flight or tool-only). */
	replyIdx: number;
	/** Absolute indexes of foldable work rows inside the turn, in CLI order. */
	workIdxs: readonly number[];
	/** Absolute indexes of tail rows (never folded), in CLI order. */
	tailIdxs: readonly number[];
	/** Absolute indexes of hook rows (never folded), in CLI order. */
	hookIdxs: readonly number[];
	/** True for the last turn in the transcript. */
	isLastTurn: boolean;
	/** True while this turn is the in-flight tail and the agent is working —
	 *  the design doc §D streaming state (work segment stays expanded). */
	isRunning: boolean;
	/** Model serving this turn (design doc turn header): the LAST
	 *  `model_change` within the turn (a mid-turn switch applies to the reply
	 *  the turn ends on), falling back to the session model. "provider/modelId"
	 *  shortened to "modelId". */
	model?: string;
}

/** "provider/modelId" → "modelId" (turn header real estate). */
function shortModel(model: string): string {
	const slash = model.lastIndexOf("/");
	return slash > 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
}

export interface BuildTurnRenderUnitsOptions {
	/** Session model for turns before any `model_change` row. */
	fallbackModel?: string;
}

/**
 * The turn's reply anchor: the LAST assistant row classified "assistantText"
 * (carries non-empty text). Unlike round-collapse's fold anchor — which falls
 * back to the last assistant row so the fold header always has somewhere to
 * hang — the M1 projection stays strict: a tool-only turn has no reply row
 * yet (design doc latestAssistantTextRow), and the renderer must not attach
 * reply actions to a toolCall-only row. -1 when there is no text reply.
 */
function lastTextReplyIdx(entries: readonly SessionEntry[], from: number, to: number): number {
	for (let i = to - 1; i > from; i--) {
		if (classifyTranscriptRow(entries[i]!) === "assistantText") return i;
	}
	return -1;
}

/**
 * Project entries into per-turn render units. Rows before the first turn
 * start (session header leftovers, pre-first-prompt notices) belong to no
 * turn and are not represented; the render layer keeps showing them as-is.
 *
 * `working` is the agent-liveness flag round-collapse uses for the same
 * in-flight boundary — passing the same value keeps fold state and render
 * units consistent.
 */
export function buildTurnRenderUnits(
	entries: readonly SessionEntry[],
	working: boolean,
	options?: BuildTurnRenderUnitsOptions,
): TurnRenderUnit[] {
	const starts: number[] = [];
	for (let i = 0; i < entries.length; i++) {
		if (isTurnStart(entries[i])) starts.push(i);
	}
	// Model serving each turn: the LAST model_change within the turn
	// (inclusive — a switch mid-turn applies to the reply the turn ends on),
	// falling back to the session model for turns with no change at all. One
	// forward pass records the model at every turn END index.
	const modelAtEnd = new Map<number, string>();
	const endIdxs = new Set<number>();
	for (let t = 0; t < starts.length; t++) {
		endIdxs.add((t + 1 < starts.length ? starts[t + 1]! : entries.length) - 1);
	}
	let currentModel = options?.fallbackModel;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i]!;
		if (e.type === "model_change") currentModel = e.model;
		if (currentModel !== undefined && endIdxs.has(i)) modelAtEnd.set(i, shortModel(currentModel));
	}
	const units: TurnRenderUnit[] = [];
	for (let t = 0; t < starts.length; t++) {
		const startIdx = starts[t]!;
		const endIdx = (t + 1 < starts.length ? starts[t + 1]! : entries.length) - 1;
		const workIdxs: number[] = [];
		const tailIdxs: number[] = [];
		const hookIdxs: number[] = [];
		for (let i = startIdx + 1; i <= endIdx; i++) {
			const kind = classifyTranscriptRow(entries[i]!);
			if (kind === "work") workIdxs.push(i);
			else if (kind === "tail") tailIdxs.push(i);
			else if (kind === "hook") hookIdxs.push(i);
		}
		const isLastTurn = t === starts.length - 1;
		const e = entries[startIdx]!;
		units.push({
			key: e.id && e.id.length > 0 ? e.id : `turn-${t}`,
			turnIndex: t,
			startIdx,
			endIdx,
			replyIdx: lastTextReplyIdx(entries, startIdx, endIdx + 1),
			workIdxs,
			tailIdxs,
			hookIdxs,
			isLastTurn,
			isRunning: working && isLastTurn,
			model: modelAtEnd.get(endIdx),
		});
	}
	return units;
}

/**
 * True while an `ask` tool call is awaiting the user: a toolCall block named
 * `ask` exists with no matching toolResult entry (toolCallId pairing). The
 * ask tool blocks the whole run, so any unmatched call is pending — the
 * design doc §B rule hides the chat-level loading then (the question card
 * owns the progress feedback).
 */
export function hasPendingAsk(entries: readonly SessionEntry[]): boolean {
	const answered = new Set<string>();
	const asked: string[] = [];
	for (const e of entries) {
		if (e.type !== "message") continue;
		const m = e.message;
		if (m.role === "toolResult") {
			const id = (m as { toolCallId?: string }).toolCallId;
			if (typeof id === "string" && id.length > 0) answered.add(id);
		} else if (m.role === "assistant") {
			const content = (m as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const b of content as Array<{ type?: string; id?: string; name?: string }>) {
				if (b?.type === "toolCall" && b.name === "ask" && typeof b.id === "string" && b.id.length > 0) {
					asked.push(b.id);
				}
			}
		}
	}
	return asked.some(id => !answered.has(id));
}

/** Inputs for the chat-loading visibility judgment (design doc §B table).
 *  Every suppression flag is caller-derived runtime state — this function
 *  stays a pure combination so the truth table is unit-testable. */
export interface ChatLoadingVisibility {
	/** Agent liveness — loading is moot when the agent isn't running. */
	working: boolean;
	/** Host-side pending tool approval (guest transport: always false;
	 *  ApprovalCard is up and owns the wait feedback). */
	approvalPending?: boolean;
	/** Structural pending `ask` question — compute with hasPendingAsk. */
	askPending?: boolean;
	/** auto_compaction_start seen without its end event. */
	compacting?: boolean;
	/** Goal-verifier pass in flight (no client-core exposure yet — reserved
	 *  flag, design doc §B investigation item). */
	goalVerifierActive?: boolean;
}

/**
 * The chat-level "thinking" loading indicator is a MODEL-liveness signal; any
 * condition where progress is blocked on the USER (approval, question) or on
 * a dedicated subsystem pass (compaction, goal verifier) suppresses it —
 * showing both the indicator and the blocking card is double feedback
 * (design doc §B1→B2).
 */
export function shouldShowChatLoading(v: ChatLoadingVisibility): boolean {
	return (
		v.working === true &&
		v.approvalPending !== true &&
		v.askPending !== true &&
		v.compacting !== true &&
		v.goalVerifierActive !== true
	);
}
