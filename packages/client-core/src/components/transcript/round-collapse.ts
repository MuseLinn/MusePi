/**
 * Completed-round collapse: a "round" is a
 * user message through the final assistant reply of that turn. When a round
 * folds, the working entries between user and final reply — tool
 * calls/results, bash executions, thinking — hide behind a header:
 * `活动 · 更改了 N 个文件 +A/−R · 探索了代码库 · 运行了 M 条命令`. The final
 * assistant message (text + artifacts) stays visible; media/widgets inside
 * the folded span ride along and re-appear on expand.
 *
 * Which rounds fold — and which assistant replies survive the fold — is the
 * presentation policy's decision (`presentation-policy.ts`); this module
 * only turns that decision into fold descriptors. The default policy folds
 * completed history, leaves the running round flat, and keeps only the
 * round's final answer.
 *
 * Pure functions only — the renderer owns the fold state per round.
 */

import { isTurnStartEntry, type SessionEntry } from "@musepi/pi-wire";
import {
	type BrowserActivityCall,
	type BrowserActivitySummary,
	browserOperationsOf,
	summarizeBrowserOperations,
} from "../../tool-render/tools/browser-activity";
import { diffStats } from "../../tool-render/tools/edit";
import { isRecord } from "../../tool-render/util";
import { DEFAULT_PRESENTATION_POLICY, type TranscriptPresentationPolicy } from "./presentation-policy";
import { classifyTranscriptRow, isProgressUpdateRow } from "./row-kinds";
import { isArtifactTool, resultPicturesOf } from "./tool-media";
import type { FoldedReplies } from "./transcript-prefs";

export { isTurnStartEntry as isTurnStart };

/** Rows whose tool output is turn OUTPUT, not process: an artifact card
 *  (`widget` / `board` / `schedule_task` / `notify_user`) or a successful
 *  result carrying pictures. The assistant row carrying the call is the row
 *  that renders the card, so that is the row to keep.
 *
 *  One interpretation serves both collapses: the round fold exempts these rows
 *  from the hidden span, and the tool-call summary refuses to summarize a run
 *  containing one. A second copy of "is this a deliverable" is exactly how a
 *  closed summary hid a card the fold would have kept. */
export function artifactRowSet(entries: readonly SessionEntry[]): Set<number> {
	const owners = new Map<string, number>();
	/** Artifact tool calls per assistant row — the card renders on the CALL row,
	 *  so a matching result is not required for the row to be an artifact. */
	const artifactCalls = new Map<number, string[]>();
	const rows = new Set<number>();
	entries.forEach((entry, index) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			owners.set(block.id, index);
			if (!isArtifactTool(block.name)) continue;
			const calls = artifactCalls.get(index) ?? [];
			calls.push(block.id);
			artifactCalls.set(index, calls);
		}
	});
	// A failed artifact call is process, not output: the card never arrives, so
	// the row folds with the rest of the round. A call with no result still
	// counts (the card renders from the call, and the result may be streamed
	// into a custom entry).
	const errored = new Set<string>();
	entries.forEach((entry, index) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult") return;
		const message = entry.message;
		const callId = (message as { toolCallId?: string }).toolCallId ?? "";
		if (message.isError === true) {
			errored.add(callId);
			return;
		}
		const owner = owners.get(callId);
		if (owner === undefined) return;
		if (resultPicturesOf(message).length > 0) rows.add(owner);
	});
	for (const [row, calls] of artifactCalls) {
		if (calls.some(callId => !errored.has(callId))) rows.add(row);
	}
	return rows;
}

/**
 * Rows a failure lives on: the assistant row carrying the failed call, the
 * failed result row itself, and a direct shell run that exited non-zero.
 *
 * The fold collects a round's PROCESS, and a failure is not process — it is the
 * reason the turn went the way it did. Folding it away leaves the reader with a
 * tidy "活动" header and no way to learn what broke without expanding the whole
 * round, so these rows are exempt from the hidden span (OpenMausBot gets the
 * same outcome differently: its fold predicate only accepts `tool.ok === true`,
 * so a failure never enters the fold at all).
 *
 * A failed ARTIFACT call is the one exception, and it is handled by
 * {@link artifactRowSet}: the card never arrives, so the row is process after
 * all.
 */
export function failedWorkRowSet(entries: readonly SessionEntry[]): Set<number> {
	const rows = new Set<number>();
	const failedCalls = new Set<string>();
	entries.forEach((entry, index) => {
		if (entry.type !== "message") return;
		const message = entry.message;
		if (message.role === "toolResult" && message.isError === true) {
			failedCalls.add(message.toolCallId);
			rows.add(index);
			return;
		}
		if (message.role === "bashExecution" && typeof message.exitCode === "number" && message.exitCode !== 0) {
			rows.add(index);
		}
	});
	if (failedCalls.size === 0) return rows;
	entries.forEach((entry, index) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		for (const block of entry.message.content) {
			if (block.type === "toolCall" && failedCalls.has(block.id)) {
				rows.add(index);
				return;
			}
		}
	});
	return rows;
}

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
	/** Non-web read/search tool results inside the span (openchamber's
	 *  探索了代码库 segment): read/grep/glob/ast-grep/inspect-image. */
	exploreCount: number;
	/** Web research results inside the span (openchamber's 调研 segment):
	 *  fetch / web-search. Counted apart from explore so the header can say
	 *  "explored the codebase · researched the web" instead of merging them. */
	webCount: number;
	/** Subagent (`task`) results inside the span — the Kimi client reports
	 *  "used N subagents" rather than folding them into a tool count. */
	subagentCount: number;
	/** File-change aggregate inside the span (更改 chip): files
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
	/** Failed calls inside the span (a failed result, or a non-zero shell run).
	 *  They stay visible, and the header names how many there were. */
	failedCount: number;
	/** Summed tool execution time inside the span; 0 when no row recorded one. */
	toolMs: number;
	/** Absolute indexes of entries that must stay visible even while the
	 *  fold is closed: (a) assistant messages carrying SUCCESSFUL artifact
	 *  tool calls (widget/board/schedule_task — the card IS the turn's
	 *  artifact); (b) assistant messages whose tool call produced a picture
	 *  (generated image or a hoisted result image — media is output, not
	 *  process); (c) tail and hook rows (design doc §C) — turn
	 *  accompaniment, not process. */
	exempt: number[];
	/** Absolute indexes of assistant replies kept visible by
	 *  `foldedReplies: "all"`. The final reply is already visible via
	 *  `finalIdx` and is not repeated here. Each kept reply renders TEXT
	 *  only — its reasoning and tool cards are process, so they fold with
	 *  the rest of the round. Empty under the default `"final"`. */
	replies: number[];
	/** True when this is the latest completed round and the policy defers its
	 *  collapse to the next user message (`collapseTiming: "next-input"`).
	 *  The fold exists (grouping modes keep their header) but the transcript
	 *  renders it OPEN by default until a later prompt makes it history. */
	deferred: boolean;
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
 *  running commands or editing). Both wire spellings are listed: the registry
 *  uses underscores (`inspect_image`, `web_search`, `ast_grep`) while older
 *  transcripts and the CLI vocabulary use hyphens. */
const EXPLORE_TOOLS = new Set([
	"read",
	"grep",
	"glob",
	"ast-grep",
	"ast_grep",
	"fetch",
	"web-search",
	"web_search",
	"inspect-image",
	"inspect_image",
]);

/** Web research tools — counted as their own segment, not as codebase
 *  exploration (openchamber's "researched" clause). */
const WEB_TOOLS = new Set(["fetch", "web-search"]);

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
	webCount: number;
	subagentCount: number;
	failedCount: number;
	toolMs: number;
	changes: { filesChanged: number; added: number; removed: number };
	preview: string;
	/** Rows that stay visible while the fold is closed: deliverable cards,
	 *  pictures, tail/hook rows, and failures. */
	exempt: number[];
} {
	let toolCount = 0;
	let commandCount = 0;
	let exploreCount = 0;
	let webCount = 0;
	let subagentCount = 0;
	let preview = "";
	const changeState = { files: new Set<string>(), added: 0, removed: 0 };
	const exempt: number[] = [];
	const artifactRows = artifactRowSet(entries);
	// A failure is the reason the turn went wrong, not process: keep its rows
	// visible (see failedWorkRowSet) and count them for the header.
	const failedRows = failedWorkRowSet(entries);
	let failedCount = 0;
	let toolMs = 0;
	for (let i = start; i <= end; i++) {
		const e = entries[i];
		// A row whose card is the turn's deliverable never folds, whatever its
		// position in the span (see artifactRowSet).
		if (artifactRows.has(i) && !exempt.includes(i)) exempt.push(i);
		if (failedRows.has(i) && !exempt.includes(i)) exempt.push(i);
		// Design doc §C: tail rows (retry_failure / async-result) and hook
		// rows are turn accompaniment, not working process — they stay
		// visible even while the fold is closed. Non-message entries are
		// skipped by the counting below anyway; classify first so the
		// accompaniment rows can be promoted out of the hidden span.
		if (e !== undefined && e.type !== "message") {
			const kind = classifyTranscriptRow(e);
			if ((kind === "tail" || kind === "hook") && !exempt.includes(i)) exempt.push(i);
			continue;
		}
		if (e?.type !== "message") continue;
		const m = e.message;
		// A progress update is content the user is meant to keep reading after
		// the turn folds: exempt its carrier row and keep it out of the tool
		// count (the result row carries no body and folds with the rest).
		if (isProgressUpdateRow(e)) {
			if (m.role === "assistant" && !exempt.includes(i)) exempt.push(i);
			continue;
		}
		if (m.role === "bashExecution") {
			commandCount++;
		} else if (m.role === "toolResult") {
			if (m.isError === true && !artifactRows.has(i)) failedCount++;
			// Absent timing (older journals, never-started calls) is unknown: it
			// contributes nothing rather than a zero that would understate.
			if (typeof m.durationMs === "number" && Number.isFinite(m.durationMs)) toolMs += Math.max(0, m.durationMs);
			if (DIFF_TOOLS.has(m.toolName)) foldChanges(m, changeState);
			if (m.toolName === "task") subagentCount++;
			else if (WEB_TOOLS.has(m.toolName)) webCount++;
			else if (EXPLORE_TOOLS.has(m.toolName)) exploreCount++;
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
		webCount,
		subagentCount,
		failedCount,
		toolMs,
		changes: { filesChanged: changeState.files.size, added: changeState.added, removed: changeState.removed },
		preview,
		exempt,
	};
}

/**
 * Compute the completed-round folds for a transcript (openchamber
 * projectTurnRecords parity — STRUCTURAL, no duration data involved): a
 * round is a user message through its last assistant reply, and any round
 * containing tool/command work folds, INCLUDING the last completed one
 * (the 活动 header then sits directly above the final reply).
 *
 * The presentation policy decides which rounds fold and how they open:
 * - `stepGrouping: "collapsed"` folds every round, including the one still
 *   running. The header groups the work; the transcript keeps a RUNNING
 *   round open by default (see `foldDefaultOpen`), and `collapseTiming`
 *   decides when the finished one closes.
 * - `"history"` (the default) folds only rounds that are history: the
 *   in-flight round streams flat, and the last completed round folds
 *   according to `collapseTiming` — `completion` folds it as soon as the
 *   agent stops, `next-input` leaves it flat until the next user message
 *   turns it into history.
 * - `"none"` (and `foldCompletedTurns: false`) folds nothing.
 */
export function buildRoundFolds(
	entries: readonly SessionEntry[],
	working: boolean,
	policy: TranscriptPresentationPolicy = DEFAULT_PRESENTATION_POLICY,
): RoundFold[] {
	if (!policy.foldCompletedTurns || policy.stepGrouping === "none") return [];
	const folds: RoundFold[] = [];
	let userIdx = -1;
	let userId: string | null = null;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (!isTurnStart(e)) continue;
		// Close the previous turn: it runs up to the row BEFORE this one.
		if (userIdx >= 0) pushFold(folds, entries, userIdx, userId, i - 1, policy.foldedReplies, false);
		userIdx = i;
		// Revert anchors on a real user message only (an advisor has no text to
		// put back in the composer).
		userId = e?.type === "message" ? (e.id ?? null) : null;
	}
	// Trailing round: everything after the last user message. Whether it folds
	// is the policy's decision; a deferred completion keeps its header (if the
	// mode groups) but opens until the next prompt.
	if (userIdx >= 0 && trailingRoundFolds(policy, working)) {
		pushFold(
			folds,
			entries,
			userIdx,
			userId,
			entries.length - 1,
			policy.foldedReplies,
			!working && policy.deferTrailingFold,
		);
	}
	return folds;
}

/** Whether the trailing (still-latest) round folds under this policy. */
function trailingRoundFolds(policy: TranscriptPresentationPolicy, working: boolean): boolean {
	// Grouping modes keep a header on the latest round in every state — a
	// deferred round is still grouped, it just opens by default (`deferred`).
	if (policy.stepGrouping === "collapsed") return true;
	// Historical grouping: next-input leaves the completed trailing round flat
	// until a later prompt turns it into history; the running round is flat.
	if (policy.deferTrailingFold) return false;
	return !working;
}

/** A turn can start at a prompt OR at an advisor note: an advisory that lands
 *  mid-run triggers its own stretch of agent work (custom_message entries with
 *  customType "advisor", display: true), and that work has to fold under an
 *  活动 row like any other turn. Matches the transcript, which renders advisor
 *  notes as first-class rows.
 *
 * Exported for render-units.ts (M1 turn projection) — both modules must agree
 * on what starts a turn, so there is ONE predicate (implemented in pi-wire so
 * the daemon-side recorder shares it). */
const isTurnStart = isTurnStartEntry;

/** Last assistant index in `(from, to)` whose content carries non-empty TEXT —
 *  the turn's REPLY. The last assistant message overall is not it: a turn can
 *  end on a thinking-only (or tool-call-only) assistant row, and anchoring there
 *  hid the row that actually holds the answer (real session: user → [thinking,
 *  text, toolCall] → toolResult → [thinking]). Falls back to the last assistant
 *  when no text block exists. */
function lastReplyIdx(entries: readonly SessionEntry[], from: number, to: number): number {
	for (let i = to - 1; i > from; i--) {
		const e = entries[i];
		if (e?.type !== "message" || e.message.role !== "assistant") continue;
		const content = (e.message as { content?: unknown }).content;
		const blocks = Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
		if (blocks.some(b => b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0)) {
			return i;
		}
	}
	return lastAssistantIdx(entries, from, to);
}

/** Last assistant-message index in `(from, to)`; -1 when none. */
function lastAssistantIdx(entries: readonly SessionEntry[], from: number, to: number): number {
	for (let i = to - 1; i > from; i--) {
		const e = entries[i];
		if (e?.type === "message" && e.message.role === "assistant") return i;
	}
	return -1;
}

/** Assistant-message indexes in `(from, to)` carrying non-empty text, in CLI
 *  order — the round's replies (`foldedReplies: "all"` keeps them visible). */
function replyIndexes(entries: readonly SessionEntry[], from: number, to: number): number[] {
	const idxs: number[] = [];
	for (let i = from + 1; i < to; i++) {
		const e = entries[i];
		if (e?.type !== "message" || e.message.role !== "assistant") continue;
		const content = (e.message as { content?: unknown }).content;
		const blocks = Array.isArray(content) ? (content as Array<{ type?: string; text?: string }>) : [];
		if (blocks.some(b => b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0)) {
			idxs.push(i);
		}
	}
	return idxs;
}

/** One round's fold computation with INDEX-RELATIVE exempt list — the
 *  cache-friendly shape: a round's span content is stable across history
 *  prepends (only absolute indexes shift), so `turn-derive.ts` caches this
 *  keyed by the span's endpoint ids and reuses it after paging. Null = the
 *  round does not fold (text-only / no reply / nothing between prompt and
 *  end). */
export interface FoldSpan {
	finalRel: number;
	toolCount: number;
	commandCount: number;
	exploreCount: number;
	webCount: number;
	subagentCount: number;
	/** Failed calls inside the span — they stay visible and the header names them. */
	failedCount: number;
	/** Summed execution time of the span's tool results that recorded one. Rows
	 *  written before timing was recorded contribute nothing (unknown, not 0). */
	toolMs: number;
	filesChanged: number;
	added: number;
	removed: number;
	preview: string;
	/** Span-row indexes relative to `startIdx` that stay visible while the
	 *  fold is closed (widget cards / tail / hook rows). Absolute = startIdx + rel. */
	exemptRel: number[];
	/** Span-row indexes relative to `startIdx` of assistant replies kept
	 *  visible by `foldedReplies: "all"` (the final reply is excluded; it is
	 *  visible through `finalRel`). */
	repliesRel: number[];
}

/** Compute one round's fold (pushFold's body, relative-exempt shape).
 *  `startIdx` = the turn-start entry, `endIdx` = the turn's LAST row
 *  (inclusive). Returns null when the round must not fold. */
export function foldSpan(
	entries: readonly SessionEntry[],
	startIdx: number,
	userId: string | null,
	endIdx: number,
	foldedReplies: FoldedReplies = "final",
): FoldSpan | null {
	// The turn must have something between the prompt and its end.
	if (endIdx <= startIdx + 1) return null;
	const replyIdx = lastReplyIdx(entries, startIdx, endIdx + 1);
	if (replyIdx <= startIdx) return null; // no reply → no anchor for the header
	// Work is counted over the WHOLE turn (process rows may sit after the
	// reply — that ordering used to count as "no activity" and produced no row).
	const {
		toolCount,
		commandCount,
		exploreCount,
		webCount,
		subagentCount,
		failedCount,
		toolMs,
		changes,
		preview,
		exempt,
	} = countWorkInside(entries, startIdx + 1, endIdx + 1);
	if (toolCount === 0 && commandCount === 0) return null; // text-only round
	// `foldedReplies: "all"` keeps every reply row visible; `"final"` (the
	// default) folds intermediate replies with the process, so they need no
	// entry of their own.
	const repliesRel =
		foldedReplies === "all"
			? replyIndexes(entries, startIdx, endIdx + 1)
					.filter(i => i !== replyIdx)
					.map(i => i - startIdx)
			: [];
	return {
		finalRel: replyIdx - startIdx,
		toolCount,
		commandCount,
		exploreCount,
		webCount,
		subagentCount,
		failedCount,
		toolMs,
		filesChanged: changes.filesChanged,
		added: changes.added,
		removed: changes.removed,
		preview,
		exemptRel: exempt.map(i => i - startIdx),
		repliesRel,
	};
}

/** Absolute fold descriptor from a span computed for the same start/end.
 *  This is the ONE projection from the relative span shape: `buildRoundFolds`
 *  and the cached `turn-derive` path both go through it, so a new header field
 *  cannot be added to one builder and forgotten in the other (the web/subagent
 *  counts had to be patched in two places before this existed). */
export function roundFoldFromSpan(
	span: FoldSpan,
	startIdx: number,
	endIdx: number,
	userId: string | null,
	deferred = false,
): RoundFold {
	return {
		startIdx,
		endIdx,
		finalIdx: startIdx + span.finalRel,
		headerIdx: startIdx + 1,
		toolCount: span.toolCount,
		commandCount: span.commandCount,
		exploreCount: span.exploreCount,
		webCount: span.webCount,
		subagentCount: span.subagentCount,
		failedCount: span.failedCount,
		toolMs: span.toolMs,
		filesChanged: span.filesChanged,
		added: span.added,
		removed: span.removed,
		userId,
		preview: span.preview,
		exempt: span.exemptRel.map(r => r + startIdx),
		replies: span.repliesRel.map(r => r + startIdx),
		deferred,
	};
}

function pushFold(
	folds: RoundFold[],
	entries: readonly SessionEntry[],
	startIdx: number,
	userId: string | null,
	endIdx: number,
	foldedReplies: FoldedReplies,
	deferred: boolean,
): void {
	const span = foldSpan(entries, startIdx, userId, endIdx, foldedReplies);
	if (span === null) return;
	folds.push(roundFoldFromSpan(span, startIdx, endIdx, userId, deferred));
}

/**
 * Default open state of one fold, before per-round reader deviations.
 *
 * A grouping mode's fold is a group header, not a request to hide the live
 * process: while its round is still running the fold opens so the work stays
 * visible. A deferred completion (`collapseTiming: "next-input"`) also stays
 * open until a later prompt makes the round history. Everything else follows
 * the global default (collapsed unless the reader picked expanded), and
 * `hideToolActivity` still forces the collapsed reading.
 *
 * @param fold - the round's fold descriptor.
 * @param options.working - the agent is running.
 * @param options.lastEntryIdx - index of the transcript's last row, used to
 *   recognize the running/in-flight round.
 * @param options.defaultExpanded - the global 消息自动折叠 choice.
 * @param options.hideToolActivity - `display.hideToolActivity` owns the
 *   process behind the fold.
 */
export function foldDefaultOpen(
	fold: RoundFold,
	options: {
		working: boolean;
		lastEntryIdx: number;
		defaultExpanded: boolean;
		hideToolActivity?: boolean;
	},
): boolean {
	if (options.hideToolActivity === true) return false;
	if (fold.deferred) return true;
	if (options.working && fold.endIdx === options.lastEntryIdx) return true;
	return options.defaultExpanded;
}

/** True when the entry at `idx` belongs inside a fold's foldable span. */
export function isInsideFold(folds: readonly RoundFold[], idx: number): boolean {
	// The reply row is never hidden (see finalIdx): expanding a fold must not
	// swallow the answer the turn produced. Exempt rows (artifact cards,
	// pictures, tail/hook accompaniment) and kept replies stay visible too —
	// see `exempt` and `replies`.
	// endIdx is INCLUSIVE (it is the turn's last row).
	return folds.some(
		f =>
			idx > f.startIdx &&
			idx <= f.endIdx &&
			idx !== f.finalIdx &&
			!f.exempt.includes(idx) &&
			!f.replies.includes(idx),
	);
}

/** Tools whose calls WRITE files — the run-summary edit segment (DIFF_TOOLS
 *  plus the plain write tool). */
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"]);

/** Extension / dynamic-plugin lifecycle tools. They reach the wire as
 *  `write xd://<tool>` device dispatches, so counting by wire name would file
 *  every plugin action under "编辑了 N 个文件"; the run gives them their own
 *  segment instead. */
const EXTENSION_TOOLS = new Set([
	"cordis_define",
	"cordis_inspect",
	"cordis_inspect_list",
	"cordis_inspect_query",
	"cordis_inspect_self",
	"cordis_run",
	"cordis_stop",
	"cordis_undefine",
	"plugin_manager",
	"ext_define",
	"ext_inspect",
	"ext_run",
	"ext_stop",
	"ext_undefine",
	"extension_load",
	"extension_reload",
	"extension_rollback",
	"extension_status",
	"extension_validate",
	"extensions_list",
]);

/** Device name behind a `write xd://<tool>` result (`details.xdev.tool`), else null. */
function xdevDeviceOf(message: { details?: unknown }): string | null {
	if (!isRecord(message.details)) return null;
	const xdev = message.details.xdev;
	if (!isRecord(xdev)) return null;
	return typeof xdev.tool === "string" && xdev.tool.length > 0 ? xdev.tool : null;
}

/** One summarized run of consecutive tool-work rows (Kimi 工具调用汇总
 *  parity): while a turn works, maximal stretches of adjacent process rows —
 *  toolCall-carrying assistants, toolResults, bash executions — collapse to
 *  ONE category-aggregated summary line (`读取了 3 个文件 · 运行了 2 个
 *  命令`) rendered at the run's head. The renderer owns per-run expand state;
 *  this module only computes which rows group together and what they add
 *  up to. */
export interface ToolRunSummary {
	/** Stable expand-state key: the head entry's id, falling back to the
	 *  absolute index for id-less entries (same stability lesson as the
	 *  round fold's userId key — history prepends shift indexes). */
	key: string;
	/** Absolute index of the run's FIRST row — where the summary line renders. */
	headIdx: number;
	/** Absolute indexes of every row in the run, in CLI order (head included). */
	idxs: number[];
	/** Read/search/browse tool results (EXPLORE_TOOLS). */
	reads: number;
	/** File-writing tool results (write / edit / apply_patch). */
	edits: number;
	/** Bash command rows. */
	commands: number;
	/** Extension / dynamic-plugin lifecycle actions (xd:// device dispatches). */
	plugins: number;
	/** Any other tool results. */
	other: number;
	/** Structured browser operations; browser calls are not counted in other. */
	browser: BrowserActivitySummary | null;
	/** Failed calls inside the run. The action still COUNTS (it happened), but
	 *  the line names the failures so a broken step is not silently averaged
	 *  into "运行了 3 个命令". */
	failed: number;
}

/**
 * Group consecutive work rows into summarizable runs. A run needs ≥2 tool
 * ACTIONS (tool results / bash rows — one call occupies two rows: the
 * assistant carrier + its result): a lone call reads fine as its own card,
 * a summary line would only add noise. Text replies, user messages,
 * tail/hook rows and timeline boundaries all break a run
 * (classifyTranscriptRow is the ONE predicate — the same vocabulary the
 * fold and the turn projection use).
 *
 * `working` guards the live tail: a run that extends to the transcript's
 * last entry while the agent streams is still executing — its spinner IS
 * the progress feedback (design doc §D), so it renders as-is until the run
 * settles or the turn ends. Settled earlier runs in the same live round DO
 * summarize (Kimi's "回答过程中，连续的工具调用自动汇总为一行摘要").
 */
function browserCallsOf(entries: readonly SessionEntry[], idxs: readonly number[]): BrowserActivityCall[] {
	const inputs = new Map<string, { args: unknown; agentId: string }>();
	const calls: BrowserActivityCall[] = [];
	for (const index of idxs) {
		const entry = entries[index];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			const agentId = "agentId" in message && typeof message.agentId === "string" ? message.agentId : "main";
			for (const block of message.content) {
				if (block.type === "toolCall" && block.name === "browser") {
					inputs.set(block.id, { args: block.arguments, agentId });
				}
			}
			continue;
		}
		if (message.role !== "toolResult" || message.toolName !== "browser") continue;
		const input = inputs.get(message.toolCallId) ?? { args: {}, agentId: "main" };
		const details = isRecord(message.details) ? message.details : undefined;
		const argRecord = isRecord(input.args) ? input.args : undefined;
		calls.push({
			agentId: input.agentId,
			tab:
				(argRecord && typeof argRecord.name === "string" ? argRecord.name : undefined) ??
				(details && typeof details.name === "string" ? details.name : "main"),
			url: details && typeof details.url === "string" ? details.url : undefined,
			args: input.args,
			isError: message.isError,
			operations: browserOperationsOf(details),
		});
	}
	return calls;
}

export function buildToolRuns(entries: readonly SessionEntry[], working: boolean): ToolRunSummary[] {
	const runs: ToolRunSummary[] = [];
	// A row whose card is the turn's deliverable (widget / board / schedule /
	// progress, and results carrying pictures) is never part of a run: the run
	// is "process", the card is output. Keeping it out of `idxs` is what makes
	// the summary structurally unable to swallow it — the old guard lived in the
	// renderer (`runBlocked`) and only knew about rows a fold happened to exempt.
	const artifactRows = artifactRowSet(entries);
	let idxs: number[] = [];
	const flush = (): void => {
		if (idxs.length > 0 && !(working && idxs[idxs.length - 1] === entries.length - 1)) {
			let reads = 0;
			let edits = 0;
			let commands = 0;
			let plugins = 0;
			let other = 0;
			let failed = 0;
			const browserCalls = browserCallsOf(entries, idxs);
			for (const i of idxs) {
				const e = entries[i];
				if (e?.type !== "message") continue;
				const m = e.message;
				if (m.role === "bashExecution") {
					commands++;
					if (typeof m.exitCode === "number" && m.exitCode !== 0) failed++;
				} else if (m.role === "toolResult") {
					// A device dispatch is categorized by the tool it actually ran;
					// the wire name is always `write`, which would read as a file edit.
					const toolName = xdevDeviceOf(m) ?? m.toolName;
					if (EXTENSION_TOOLS.has(toolName)) plugins++;
					else if (EXPLORE_TOOLS.has(toolName)) reads++;
					else if (WRITE_TOOLS.has(toolName)) edits++;
					// A plain bash toolResult (auto-approval run) is a command,
					//  not "other" — the summary's 命令 segment owns it.
					else if (toolName === "bash") commands++;
					else if (toolName !== "browser") other++;
					if (m.isError === true) failed++;
				}
			}
			if (reads + edits + commands + plugins + other + browserCalls.length >= 2) {
				const head = entries[idxs[0]];
				runs.push({
					key: head?.id ?? `idx:${idxs[0]}`,
					headIdx: idxs[0],
					idxs,
					reads,
					edits,
					commands,
					plugins,
					other,
					browser: browserCalls.length > 0 ? summarizeBrowserOperations(browserCalls) : null,
					failed,
				});
			}
		}
		idxs = [];
	};
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		// Progress updates are turn content: a run must not swallow one into
		// its aggregated line, and the row itself is not a summarizable action.
		if (entry !== undefined && isProgressUpdateRow(entry)) {
			flush();
			continue;
		}
		// A subagent's result is an agent's work, not a step of THIS run: keep it
		// as its own row and end the run around it (Kimi Code client parity —
		// `task` never joins an activity run). The call row is a work row too, so
		// break on either side instead of only on the result.
		if (isSubagentRow(entry)) {
			flush();
			continue;
		}
		if (artifactRows.has(i) || isArtifactResultRow(entry)) {
			flush();
			continue;
		}
		if (classifyTranscriptRow(entry) === "work") idxs.push(i);
		else flush();
	}
	flush();
	return runs;
}

/** A row that carries subagent work: the `task` tool call or its result. */
function isSubagentRow(entry: SessionEntry | undefined): boolean {
	if (entry === undefined || entry.type !== "message") return false;
	const message = entry.message;
	if (message.role === "toolResult") return message.toolName === "task";
	if (message.role !== "assistant") return false;
	return message.content.some(block => block.type === "toolCall" && block.name === "task");
}

/** The result half of an artifact call. `artifactRowSet` marks the CALL row
 *  (that is where the card renders), so the matching result is the boundary
 *  that would otherwise open the next run with a row that draws nothing. */
function isArtifactResultRow(entry: SessionEntry | undefined): boolean {
	if (entry === undefined || entry.type !== "message" || entry.message.role !== "toolResult") return false;
	return isArtifactTool(entry.message.toolName);
}

/** Default: a running turn keeps every row visible. */
export const LIVE_ACTIVITY_ROWS_UNLIMITED = 0;

/** What the in-flight trim hides, and what the "+N more" line must say. */
export interface LiveActivityTrim {
	/** Absolute index of the first VISIBLE row; rows before it are folded. */
	firstVisibleIdx: number;
	/** How many rows the "+N more" line counts. */
	hiddenCount: number;
}

/**
 * Keep a running turn's tail in view and fold the rest behind a count.
 *
 * A turn that runs for minutes streams a row per tool call, so the transcript
 * scrolls away from the work. Showing only its latest rows holds the tail still
 * while the count keeps the earlier ones reachable.
 *
 * Only the IN-FLIGHT span qualifies: a settled turn is governed by its round
 * fold, and trimming it as well would change the content under the fold's own
 * animation. Callers pass exactly that span, so this is a pure count.
 *
 * `visibleRows <= 0` means unlimited (the default) — watching the agent work is
 * the transcript, and the fold belongs to the FINISHED turn.
 */
export function planLiveActivityTrim(rows: readonly number[], visibleRows: number): LiveActivityTrim | null {
	// `visibleRows <= 0` is a real branch: 0 is the schema default and means
	// "unlimited", not a literal the compiler can fold.
	if (visibleRows <= 0 || rows.length <= visibleRows) return null;
	const hiddenCount = rows.length - visibleRows;
	return { firstVisibleIdx: rows[hiddenCount] ?? rows[rows.length - 1]!, hiddenCount };
}
