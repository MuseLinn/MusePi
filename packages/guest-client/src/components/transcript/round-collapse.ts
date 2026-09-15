/**
 * Completed-round collapse (craft-agents TurnCard parity): a "round" is a
 * user message through the final assistant reply of that turn. When a round
 * is complete (its final assistant message has a frozen round duration) and
 * is NOT the live tail, the working entries between user and final reply —
 * tool calls/results, bash executions, thinking — fold behind a header:
 * `已工作 hh:mm:ss · N 个工具 · M 个命令` with an intent preview. The final
 * assistant message (text + artifacts) stays visible; media/widgets inside
 * the folded span ride along and re-appear on expand.
 *
 * Pure functions only — the renderer owns the fold state per round.
 */

import type { SessionEntry } from "@musepi/pi-wire";
import { diffStats } from "../../tool-render/tools/edit";
import { isRecord } from "../../tool-render/util";

/** One completed round's fold descriptor. */
export interface RoundFold {
	/** Absolute entry index of the round's user message. */
	startIdx: number;
	/** Absolute entry index of the final assistant message — the turn's visible
	 *  reply, kept out of the hidden span so it always reads. */
	finalIdx: number;
	/** Absolute index of the LAST row belonging to this turn. openchamber's
	 *  model is `turn = user message + its direct assistant children`, i.e. the
	 *  turn runs to the NEXT user message — command/tool rows emitted AFTER the
	 *  final reply are part of it. Spanning only up to the reply left such
	 *  turns with an empty span, so no 活动 row was produced at all
	 *  (user: 单轮消息还是没有显示摘要行折叠块). */
	endIdx: number;
	/** Absolute index the 活动 header renders at: the turn's FIRST content row,
	 *  so expanding yields 活动 → process → reply (openchamber's order; it hangs
	 *  the header on the turn's first assistant message). */
	headerIdx: number;
	/** Tool-call count inside the foldable span (assistant toolCall blocks). */
	toolCount: number;
	/** Bash-command count inside the foldable span (bashExecution rows). */
	commandCount: number;
	/** Read/search/browse tool calls inside the span (openchamber's
	 *  探索了代码库 segment): read/grep/glob/fetch/web-search/inspect. */
	exploreCount: number;
	/** File-change aggregate inside the span (ZCode 更改 chip parity): files
	 *  touched by edit/apply_patch tool results + summed diff lines. Zero
	 *  when the round edited nothing — the header omits the chip then. */
	filesChanged: number;
	added: number;
	removed: number;
	/** Id of the round's user message — the revert anchor for the fold
	 *  header's undo action (session.branchAt parity with the per-message
	 *  revert button). */
	userId: string | null;
	/** Fold-preview text: last non-empty working snippet, else "completed". */
	preview: string;
}

/** Last non-empty text snippet of a toolResult, for the fold preview. */
function toolResultSnippet(m: { content?: unknown }): string {
	const text = Array.isArray(m.content)
		? m.content
				.map(b => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
				.join(" ")
				.trim()
				.slice(0, 60)
		: "";
	return text.replace(/\s+/g, " ");
}

/** Tools whose results carry diff details (single-source: their renderer is
 *  tool-render/tools/edit.tsx). */
const DIFF_TOOLS = new Set(["edit", "apply_patch"]);

/** Read/search/browse tools — the openchamber 活动 header's 探索了代码库
 *  segment counts these (the round looked at the codebase instead of only
 *  running commands or editing). */
const EXPLORE_TOOLS = new Set(["read", "grep", "glob", "ast-grep", "fetch", "web-search", "inspect-image"]);

/** Aggregate file-change stats from one edit/apply_patch toolResult's
 *  details — `details.diff` + `details.path` for single-file results,
 *  `details.perFileResults[]` for multi-file ones. Error results and
 *  erroring per-file entries contribute nothing. */
function foldChanges(m: { details?: unknown }, state: { files: Set<string>; added: number; removed: number }): void {
	if (!isRecord(m.details)) return;
	const perFile = Array.isArray(m.details.perFileResults) ? m.details.perFileResults : null;
	if (perFile && perFile.length > 0) {
		for (const f of perFile) {
			if (!isRecord(f) || f.isError === true) continue;
			const diff = typeof f.diff === "string" ? f.diff : null;
			if (diff === null) continue;
			const path = typeof f.path === "string" && f.path.length > 0 ? f.path : "?";
			const stats = diffStats(diff);
			state.files.add(path);
			state.added += stats.added;
			state.removed += stats.removed;
		}
		return;
	}
	const diff = typeof m.details.diff === "string" ? m.details.diff : null;
	if (diff === null) return;
	const path = typeof m.details.path === "string" && m.details.path.length > 0 ? m.details.path : "?";
	const stats = diffStats(diff);
	state.files.add(path);
	state.added += stats.added;
	state.removed += stats.removed;
}

/** Count tools/commands/changes inside the foldable span and derive the
 *  preview. The final assistant message's own toolCall blocks count too (the
 *  tools the round ran live in its final reply, not just the intermediate
 *  rows). */
function countWorkInside(
	entries: readonly SessionEntry[],
	start: number,
	end: number,
): {
	toolCount: number;
	commandCount: number;
	exploreCount: number;
	changes: { filesChanged: number; added: number; removed: number };
	preview: string;
} {
	let toolCount = 0;
	let commandCount = 0;
	let exploreCount = 0;
	let preview = "";
	const changeState = { files: new Set<string>(), added: 0, removed: 0 };
	for (let i = start; i <= end; i++) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const m = e.message;
		if (m.role === "bashExecution") {
			commandCount++;
		} else if (m.role === "toolResult") {
			if (DIFF_TOOLS.has(m.toolName)) foldChanges(m, changeState);
			if (EXPLORE_TOOLS.has(m.toolName)) exploreCount++;
			if (!preview) preview = toolResultSnippet(m);
		} else if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "toolCall") toolCount++;
			}
		}
	}
	return {
		toolCount,
		commandCount,
		exploreCount,
		changes: { filesChanged: changeState.files.size, added: changeState.added, removed: changeState.removed },
		preview,
	};
}

/**
 * Compute the completed-round folds for a transcript. A round is complete
 * when its final assistant message has a frozen duration; the LAST complete
 * round is excluded (it is the live tail and stays expanded). Work without a
 * preceding user message in the window is not folded.
/**
 * Compute the completed-round folds for a transcript (openchamber
 * projectTurnRecords parity — STRUCTURAL, no duration data involved): a
 * round is a user message through its last assistant reply, and any round
 * containing tool/command work folds, INCLUDING the last completed one
 * (the 活动 header then sits directly above the final reply). The only
 * exempt span is the IN-FLIGHT round — while `working`, entries after the
 * last user message stream live and stay expanded; once the agent stops,
 * that round folds like every other.
 */
export function buildRoundFolds(entries: readonly SessionEntry[], working: boolean): RoundFold[] {
	// While a turn is in flight, its entries (after the last user message)
	// stream live — find that boundary so the in-flight round never folds.
	let inFlightFrom = -1;
	if (working) {
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type === "message" && e.message.role === "user") {
				inFlightFrom = i;
				break;
			}
		}
	}
	const folds: RoundFold[] = [];
	let userIdx = -1;
	let userId: string | null = null;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const m = e.message;
		if (m.role === "user") {
			// Close the previous turn: it runs up to the row BEFORE this prompt.
			if (userIdx >= 0) pushFold(folds, entries, userIdx, userId, i - 1);
			userIdx = i;
			userId = e.id;
		}
	}
	// Trailing round: everything after the last user message. While working
	// it is the in-flight turn (exempt); once idle it folds like the rest.
	if (!working && userIdx >= 0) {
		pushFold(folds, entries, userIdx, userId, entries.length - 1);
	}
	return folds;
}

/** Last assistant-message index in `(from, to)`; -1 when none. */
function lastAssistantIdx(entries: readonly SessionEntry[], from: number, to: number): number {
	for (let i = to - 1; i > from; i--) {
		const e = entries[i];
		if (e?.type === "message" && e.message.role === "assistant") return i;
	}
	return -1;
}

function pushFold(
	folds: RoundFold[],
	entries: readonly SessionEntry[],
	startIdx: number,
	userId: string | null,
	endIdx: number,
): void {
	// The turn must have something between the prompt and its end.
	if (endIdx <= startIdx + 1) return;
	const replyIdx = lastAssistantIdx(entries, startIdx, endIdx + 1);
	if (replyIdx <= startIdx) return; // no reply → no anchor for the header
	// Work is counted over the WHOLE turn (process rows may sit after the
	// reply — that ordering used to count as "no activity" and produced no row).
	const { toolCount, commandCount, exploreCount, changes, preview } = countWorkInside(
		entries,
		startIdx + 1,
		endIdx + 1,
	);
	if (toolCount === 0 && commandCount === 0) return; // text-only round
	folds.push({
		startIdx,
		endIdx,
		finalIdx: replyIdx,
		headerIdx: startIdx + 1,
		toolCount,
		commandCount,
		exploreCount,
		filesChanged: changes.filesChanged,
		added: changes.added,
		removed: changes.removed,
		userId,
		preview,
	});
}

/** True when the entry at `idx` belongs inside a fold's foldable span. */
export function isInsideFold(folds: readonly RoundFold[], idx: number): boolean {
	// The reply row is never hidden (see finalIdx): expanding a fold must not
	// swallow the answer the turn produced.
	return folds.some(f => idx > f.startIdx && idx < f.endIdx && idx !== f.finalIdx);
}
