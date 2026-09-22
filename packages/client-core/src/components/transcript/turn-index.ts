import type { SessionEntry } from "@musepi/pi-wire";
import { msgText } from "./transcript-content";

/**
 * M1.11 turn metadata index: one lightweight record per USER message (turn
 * start). The TurnRail used to measure turn positions from the DOM
 * (`querySelectorAll(".tr-row--user")`), which broke in two directions once
 * the render window (Transcript.tsx) mounts only the tail slice:
 *  1. turns outside the window had no rows to measure — the rail silently
 *     dropped them (user: 侧边导航条无法显示全量轮次);
 *  2. every prepend/window expansion re-measured the WHOLE list.
 *
 * This index is derived from `entries` (the loaded set — the daemon tails
 * the wire payload and pages older chunks via session.history, so "loaded"
 * grows only as the user scrolls up) and stays intentionally tiny
 * (~120 bytes/turn), cheap to rebuild even for tens of thousands of turns.
 *
 * Position (content-space `top`) is deliberately NOT stored: row heights
 * are variable, and measuring only the mounted window rows on demand is
 * both cheaper and always correct. Jumps target the row's `title=<timestamp>`
 * attribute (the same key jumpFlashRow uses), so an out-of-window turn is
 * handled by the caller dispatching a jumpRequest — Transcript grows its
 * render window and flashes the row once mounted.
 */

/** Preview truncation — the same 90-char rule the DOM-measured rail used. */
export const TURN_SUMMARY_MAX = 90;

export interface TurnIndexItem {
	/** Absolute entry index of the turn's user message. */
	startIdx: number;
	/** Entry id (stable identity). */
	entryId: string;
	/** User message timestamp — the rendered row carries `title=<timestamp>`;
	 *  the jump/scroll-spy paths key off it. */
	timestamp: string;
	/** Single-line prompt preview (whitespace-collapsed, ≤90 chars). */
	summary: string;
}

export function buildTurnIndex(entries: readonly SessionEntry[]): TurnIndexItem[] {
	const out: TurnIndexItem[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e?.type !== "message" || e.message.role !== "user") continue;
		out.push({
			startIdx: i,
			entryId: e.id,
			timestamp: e.timestamp,
			summary: msgText(e.message)
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, TURN_SUMMARY_MAX),
		});
	}
	return out;
}
