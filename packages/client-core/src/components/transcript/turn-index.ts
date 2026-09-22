import type { CustomMessageEntry, SessionEntry } from "@musepi/pi-wire";
import { msgText } from "./transcript-content";
import { isTurnStart } from "./round-collapse.js";

/**
 * M1.11 turn metadata index: one lightweight record per turn start, where
 * "turn start" is the SHARED isTurnStart predicate (round-collapse.ts) — a
 * user prompt OR a displayed advisor note. The TurnRail used to measure turn
 * positions from the DOM (`querySelectorAll(".tr-row--user")`), which broke
 * in two directions once the render window (Transcript.tsx) mounts only the
 * tail slice:
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
 * attribute (the same key jumpFlashRow uses) — custom rows carry their
 * timestamp title too, so advisor-started turns jump exactly like prompts.
 *
 * 语义统一:顾问(advisor)落地触发 agent 自己一段工作,折叠/渲染层
 * (round-collapse / render-units / turn-derive)早已把它算作一轮;本索引
 * 与它们共用同一个 isTurnStart 谓词,导航条因此不再漏掉顾问轮次。
 */

/** Preview truncation — the same 90-char rule the DOM-measured rail used. */
export const TURN_SUMMARY_MAX = 90;

/** What kind of entry started the turn — advisor turns render a distinct
 *  rail glyph so a prompt and an advisory are distinguishable at a glance. */
export type TurnKind = "user" | "advisor";

export interface TurnIndexItem {
	/** Absolute entry index of the turn's start entry. */
	startIdx: number;
	/** Entry id (stable identity). */
	entryId: string;
	/** Start-entry timestamp — the rendered row carries `title=<timestamp>`;
	 *  the jump/scroll-spy paths key off it. */
	timestamp: string;
	/** Single-line preview (whitespace-collapsed, ≤90 chars). */
	summary: string;
	/** "user" prompt or "advisor" note — the rail styles them differently. */
	kind: TurnKind;
}

/** Advisor note text: content is a plain string or a TextContent/ImageContent
 *  array — only text blocks contribute (an image-only advisory falls back to
 *  a generic label the rail already localizes). */
function customText(content: CustomMessageEntry["content"]): string {
	if (typeof content === "string") return content;
	return content.map(b => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join(" ");
}

export function buildTurnIndex(entries: readonly SessionEntry[]): TurnIndexItem[] {
	const out: TurnIndexItem[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		// ONE predicate shared with the fold/render layers — see isTurnStart.
		if (!isTurnStart(e)) continue;
		if (e.type === "message") {
			if (e.message.role !== "user") continue;
			out.push({
				startIdx: i,
				entryId: e.id,
				timestamp: e.timestamp,
				summary: msgText(e.message).replace(/\s+/g, " ").trim().slice(0, TURN_SUMMARY_MAX),
				kind: "user",
			});
		} else if (e.type === "custom_message") {
			out.push({
				startIdx: i,
				entryId: e.id,
				timestamp: e.timestamp,
				summary: customText(e.content).replace(/\s+/g, " ").trim().slice(0, TURN_SUMMARY_MAX),
				kind: "advisor",
			});
		}
	}
	return out;
}
