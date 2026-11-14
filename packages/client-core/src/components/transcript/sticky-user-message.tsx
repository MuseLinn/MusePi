/**
 * Sticky current-turn prompt: once the round's user message scrolls out of the
 * viewport top while its turn still occupies the viewport, the prompt stays
 * reachable as a one-line pill pinned under the top chrome (Kimi TUI parity,
 * `.analysis/kimi-code/.../tui/utils/sticky-user-message.ts`).
 *
 * The judgment is purely index-based: entry-level virtualization already
 * mounts only the viewport window, so the prompt's round is still on screen
 * exactly when the nearest turn-start row at or above the first visible row is
 * a user prompt strictly above it. Pixel measurement (line heights,
 * wraparound) is the terminal renderer's problem; a DOM row is either mounted
 * and visible or not.
 */
import { isTurnStartEntry, type SessionEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { textWithoutDisplayContext } from "../../messages/display-context";
import { msgText } from "./transcript-content";

/** Entry indexes intersecting the transcript viewport, inclusive. */
export interface VisibleEntryRange {
	first: number;
	last: number;
}

/** Layout facts the virtualizer exposes per mounted row. */
export interface VirtualRowBox {
	index: number;
	start: number;
	end: number;
}

export interface StickyUserCandidate {
	entry: SessionEntry;
	/** Index in the rendered entry list — the jump target. */
	index: number;
	/** Whitespace-collapsed prompt text; empty prompts never become candidates. */
	summary: string;
}

/**
 * Trim the virtualizer's mounted (viewport + overscan) rows to the window that
 * actually intersects `[scrollTop, scrollTop + viewportHeight)`. Rows with zero
 * height never intersect, so a folded slot is not "visible" for this purpose.
 */
export function visibleEntryRange(
	rows: readonly VirtualRowBox[],
	scrollTop: number,
	viewportHeight: number,
): VisibleEntryRange | null {
	if (rows.length === 0 || !Number.isFinite(scrollTop) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) {
		return null;
	}
	const bottom = scrollTop + viewportHeight;
	let first: number | null = null;
	let last: number | null = null;
	for (const row of rows) {
		if (!Number.isFinite(row.start) || !Number.isFinite(row.end)) continue;
		if (row.end <= scrollTop || row.start >= bottom) continue;
		if (first === null || row.index < first) first = row.index;
		if (last === null || row.index > last) last = row.index;
	}
	return first === null || last === null ? null : { first, last };
}

/**
 * The prompt of the turn occupying the viewport top, when that prompt has
 * scrolled above the viewport. Rules:
 *
 * - a turn-start row exactly at `first` means its own row is visible → hide;
 * - a turn-start above `first` that is an advisor note belongs to the current
 *   turn (advisor notes open turns too), so the previous prompt's round has
 *   ended above the viewport → hide;
 * - no turn start above `first` at all means the prompt is not loaded or the
 *   viewport is at the very top → hide.
 */
export function pickStickyUserEntry(
	entries: readonly SessionEntry[],
	visible: VisibleEntryRange,
): StickyUserCandidate | null {
	const first = Math.floor(visible.first);
	const last = Math.floor(visible.last);
	if (entries.length === 0 || !Number.isFinite(first) || !Number.isFinite(last)) return null;
	if (first < 0 || first >= entries.length || last < first) return null;

	for (let index = first; index >= 0; index--) {
		const entry = entries[index];
		if (entry === undefined || !isTurnStartEntry(entry)) continue;
		if (index === first) return null;
		if (entry.type !== "message" || entry.message.role !== "user") return null;
		const summary = promptSummary(entry);
		return summary.length === 0 ? null : { entry, index, summary };
	}
	return null;
}

function promptSummary(entry: SessionEntry): string {
	if (entry.type !== "message" || entry.message.role !== "user") return "";
	// Quote/annotation prompts carry a structured prefix the transcript renders
	// as its own card; the pill summarizes what the user actually said.
	const text = textWithoutDisplayContext(msgText(entry.message), entry.message.displayContext);
	return text.replace(/\s+/gu, " ").trim();
}

export interface StickyUserMessageProps {
	candidate: StickyUserCandidate | null;
	onJump(candidate: StickyUserCandidate): void;
}

/**
 * Glass pill for the pinned prompt. Rendered only when a prompt is pinned, so
 * returning to the turn's head removes the control (and its space in the
 * accessibility tree) entirely. No enter/exit animation: it appears and
 * disappears with the scroll position.
 *
 * The turn's own avatar is NOT duplicated here. An earlier version pinned the
 * orb beside the pill once its row scrolled out, which read as a second avatar
 * floating over the message — scrolling now simply takes the turn's one avatar
 * with it.
 */
export function StickyUserMessage({ candidate, onJump }: StickyUserMessageProps): ReactNode {
	if (candidate === null) return null;
	const action = t("settings.trajectoryJump");
	return (
		<div className="tr-sticky-user-slot">
			<button
				type="button"
				className="tr-sticky-user"
				onClick={() => onJump(candidate)}
				aria-label={`${action} ${candidate.summary}`}
				title={candidate.summary}
			>
				<span className="tr-sticky-user-mark" aria-hidden="true" />
				<span className="tr-sticky-user-text">{candidate.summary}</span>
			</button>
		</div>
	);
}
