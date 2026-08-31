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

/** One completed round's fold descriptor. */
export interface RoundFold {
	/** Absolute entry index of the round's user message. */
	startIdx: number;
	/** Absolute entry index of the final assistant message (the foldable
	 *  span is `(startIdx, finalIdx)`). */
	finalIdx: number;
	/** Frozen round duration (ms) — from roundDurations. */
	durationMs: number;
	/** Tool-call count inside the foldable span (assistant toolCall blocks). */
	toolCount: number;
	/** Bash-command count inside the foldable span (bashExecution rows). */
	commandCount: number;
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

/** Count tools/commands inside the foldable span and derive the preview.
 *  The final assistant message's own toolCall blocks count too (the tools
 *  the round ran live in its final reply, not just the intermediate rows). */
function countWorkInside(
	entries: readonly SessionEntry[],
	start: number,
	end: number,
): { toolCount: number; commandCount: number; preview: string } {
	let toolCount = 0;
	let commandCount = 0;
	let preview = "";
	for (let i = start; i <= end; i++) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const m = e.message;
		if (m.role === "bashExecution") {
			commandCount++;
			continue;
		}
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type === "toolCall") toolCount++;
			}
			continue;
		}
		if (m.role === "toolResult" && !preview) preview = toolResultSnippet(m);
	}
	return { toolCount, commandCount, preview };
}

/**
 * Compute the completed-round folds for a transcript. A round is complete
 * when its final assistant message has a frozen duration; the LAST complete
 * round is excluded (it is the live tail and stays expanded). Work without a
 * preceding user message in the window is not folded.
 */
export function buildRoundFolds(
	entries: readonly SessionEntry[],
	roundDurations: ReadonlyMap<number, number> | undefined,
): RoundFold[] {
	// Locate the last complete round's final assistant index (skip it).
	let lastCompleteFinal = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type !== "message" || e.message.role !== "assistant") continue;
		const dur = roundDurations?.get(e.message.timestamp);
		if (typeof dur === "number") {
			lastCompleteFinal = i;
			break;
		}
	}
	const folds: RoundFold[] = [];
	let userIdx = -1;
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e?.type !== "message") continue;
		const m = e.message;
		if (m.role === "user") {
			userIdx = i;
			continue;
		}
		if (m.role !== "assistant") continue;
		const dur = roundDurations?.get(m.timestamp);
		if (typeof dur !== "number") continue;
		if (i === lastCompleteFinal) continue; // live tail stays expanded
		if (userIdx < 0 || i - userIdx <= 1) continue; // nothing to fold
		const { toolCount, commandCount, preview } = countWorkInside(entries, userIdx + 1, i);
		folds.push({ startIdx: userIdx, finalIdx: i, durationMs: dur, toolCount, commandCount, preview });
	}
	return folds;
}

/** True when the entry at `idx` belongs inside a fold's foldable span. */
export function isInsideFold(folds: readonly RoundFold[], idx: number): boolean {
	return folds.some(f => idx > f.startIdx && idx < f.finalIdx);
}

/** Format a duration as hh:mm:ss (kimiwork 已工作 parity). */
export function formatRoundDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number): string => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
