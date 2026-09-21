import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { buildRoundFolds, isInsideFold } from "./round-collapse";

/** Minimal EntryBase fields shared by every SessionEntry. */
const base = { parentId: null, timestamp: "0" };

let seq = 0;
function withId(overrides: object): SessionEntry {
	return { ...base, id: `e${++seq}`, ...overrides } as unknown as SessionEntry;
}

const userMsg = (text = "hi"): SessionEntry =>
	withId({ type: "message", message: { role: "user", content: text, timestamp: 1 } });

const assistantText = (text = "ok"): SessionEntry =>
	withId({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } });

const assistantToolCall = (id: string, name = "read"): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], timestamp: 1 },
	});

const toolResult = (toolCallId: string, toolName = "read"): SessionEntry =>
	withId({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: "out" }],
			isError: false,
			timestamp: 1,
		},
	});

const custom = (customType: string): SessionEntry =>
	withId({ type: "custom_message", customType, content: "x", display: true });

describe("buildRoundFolds tail/hook exemption (design doc §C)", () => {
	test("tail rows stay visible while the fold is closed", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			custom("retry_failure"),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds).toHaveLength(1);
		// The retry_failure entry (index 3) is inside the span but exempt.
		expect(folds[0]!.exempt).toContain(3);
		expect(isInsideFold(folds, 3)).toBe(false);
		// Process rows still fold.
		expect(isInsideFold(folds, 1)).toBe(true);
		expect(isInsideFold(folds, 2)).toBe(true);
		// The reply never folds.
		expect(isInsideFold(folds, 4)).toBe(false);
	});

	test("hook rows stay visible while the fold is closed", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			custom("hook:lint-check"),
			custom("hook"),
			assistantText("done"),
		];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).toContain(3);
		expect(folds[0]!.exempt).toContain(4);
		expect(isInsideFold(folds, 3)).toBe(false);
		expect(isInsideFold(folds, 4)).toBe(false);
	});

	test("unrelated custom rows are NOT exempt", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), custom("advisor"), assistantText("done")];
		const folds = buildRoundFolds(entries, false);
		expect(folds[0]!.exempt).not.toContain(3);
	});

	test("in-flight round never folds (existing behavior preserved)", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantText("streaming…")];
		expect(buildRoundFolds(entries, true)).toHaveLength(0);
		expect(buildRoundFolds(entries, false)).toHaveLength(1);
	});
});
