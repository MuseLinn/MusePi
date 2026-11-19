import { afterEach, describe, expect, test } from "bun:test";
import { WidgetService } from "../../src/daemon/services/widget-service";
import {
	answerWidget,
	awaitWidgetAnswer,
	clearWidgetAnswers,
	pendingWidgetAnswers,
} from "../../src/tools/widget-answer";

afterEach(() => clearWidgetAnswers());

describe("widget answers", () => {
	test("a waiting page resolves with the user's answer", async () => {
		const waiting = awaitWidgetAnswer("call-1");
		expect(pendingWidgetAnswers()).toBe(1);
		expect(answerWidget("call-1", { text: "Plan A", data: { plan: "a" } })).toBe(true);
		await expect(waiting).resolves.toEqual({ text: "Plan A", data: { plan: "a" } });
		expect(pendingWidgetAnswers()).toBe(0);
	});

	test("an unknown or answered call is not acknowledged twice", async () => {
		expect(answerWidget("missing", { text: "x" })).toBe(false);
		const waiting = awaitWidgetAnswer("call-2");
		answerWidget("call-2", { text: "first" });
		expect(answerWidget("call-2", { text: "second" })).toBe(false);
		await expect(waiting).resolves.toEqual({ text: "first" });
	});

	test("aborting the turn settles the wait with null", async () => {
		const controller = new AbortController();
		const waiting = awaitWidgetAnswer("call-3", controller.signal);
		controller.abort();
		await expect(waiting).resolves.toBeNull();
		expect(pendingWidgetAnswers()).toBe(0);
	});

	test("the RPC service reports a stale answer instead of pretending", async () => {
		const service = new WidgetService();
		expect(service.answer({ toolCallId: "missing", text: "x" })).toEqual({
			error: "No page is waiting for an answer.",
		});
		const waiting = awaitWidgetAnswer("call-4");
		expect(service.answer({ toolCallId: "call-4", text: "yes" })).toEqual({ ok: true });
		await expect(waiting).resolves.toEqual({ text: "yes" });
	});

	test("the RPC validates its inputs", () => {
		const service = new WidgetService();
		expect(() => service.answer({})).toThrow("toolCallId");
		expect(() => service.answer({ toolCallId: "x" })).toThrow("text");
	});
});
