/**
 * WidgetService — answers from a page that holds the turn (`widget` +
 * `awaitAnswer`).
 *
 * Capability seam:
 * - Input: RPC `widget.answer` `{toolCallId, text, data?}`; the client sends
 *   it when the user answers inside the page instead of typing a message.
 * - Output: `{ok:true}` when a waiting `widget` call consumed the answer, or
 *   `{error}` when nothing was waiting (a stale card must not be acknowledged).
 * - Lifecycle: stateless; the pending table lives with the tool invocation and
 *   settles on abort.
 */
import { answerWidget } from "../../tools/widget-answer";
import type { DaemonService } from "./types";

/** Same ceiling the page's submit bridge applies before it leaves the frame. */
const MAX_ANSWER_TEXT = 8_000;

export class WidgetService implements DaemonService {
	readonly key = "widget";
	readonly routes = { "widget.answer": "answer" } as const;

	answer(params: unknown): { ok: true } | { error: string } {
		const p = (params ?? {}) as { toolCallId?: unknown; text?: unknown; data?: unknown };
		if (typeof p.toolCallId !== "string" || !p.toolCallId) {
			throw new Error("widget.answer: toolCallId is required");
		}
		if (typeof p.text !== "string") throw new Error("widget.answer: text is required");
		const text = p.text.length > MAX_ANSWER_TEXT ? p.text.slice(0, MAX_ANSWER_TEXT) : p.text;
		const accepted = answerWidget(p.toolCallId, {
			text,
			...(p.data === undefined ? {} : { data: p.data }),
		});
		return accepted ? { ok: true } : { error: "No page is waiting for an answer." };
	}
}
