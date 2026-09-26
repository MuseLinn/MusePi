import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { buildRoundFolds, buildToolRuns, isInsideFold } from "./round-collapse";

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

const bash = (): SessionEntry =>
	withId({
		type: "message",
		message: { role: "bashExecution", command: "ls", content: [], timestamp: 1 },
	});

const thinkingOnly = (): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], timestamp: 1 },
	});

describe("buildToolRuns (工具调用汇总, Kimi parity)", () => {
	test("a settled stretch of consecutive tool rows groups into one run with category counts", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1", "read"),
			toolResult("c1", "read"),
			assistantToolCall("c2", "grep"),
			toolResult("c2", "grep"),
			assistantToolCall("c3", "edit"),
			toolResult("c3", "edit"),
			bash(),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.headIdx).toBe(1);
		expect(runs[0]!.idxs).toEqual([1, 2, 3, 4, 5, 6, 7]);
		expect(runs[0]!.reads).toBe(2);
		expect(runs[0]!.edits).toBe(1);
		expect(runs[0]!.commands).toBe(1);
		expect(runs[0]!.other).toBe(0);
	});

	test("the run key is the head entry's id — stable across history prepends", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantToolCall("c2"), toolResult("c2")];
		const runs = buildToolRuns(entries, false);
		expect(runs[0]!.key).toBe(entries[1]!.id);
	});

	test("a lone tool call is not summarized — a summary line would only add noise", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantText("done")];
		expect(buildToolRuns(entries, false)).toHaveLength(0);
	});

	test("text replies, thinking rows and user messages break a run", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1", "read"),
			assistantToolCall("c2"),
			toolResult("c2", "grep"),
			assistantText("interim answer"),
			bash(),
			assistantToolCall("c3"),
			toolResult("c3", "read"),
			assistantText("done"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs).toHaveLength(2);
		expect(runs[0]!.idxs).toEqual([1, 2, 3, 4]);
		expect(runs[1]!.idxs).toEqual([6, 7, 8]);
	});

	test("while streaming, the run extending to the last entry stays live (spinner is the progress)", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1"), assistantToolCall("c2"), toolResult("c2")];
		expect(buildToolRuns(entries, true)).toHaveLength(0);
		// Once the turn ends the same rows summarize — 开 × 回合结束.
		expect(buildToolRuns(entries, false)).toHaveLength(1);
	});

	test("while streaming, SETTLED earlier runs still summarize (回答过程中已完成的汇总)", () => {
		const entries = [
			userMsg(),
			assistantToolCall("c1"),
			toolResult("c1"),
			assistantToolCall("c2"),
			toolResult("c2"),
			assistantText("interim"),
			assistantToolCall("c3"),
			toolResult("c3"),
		];
		const runs = buildToolRuns(entries, true);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.idxs).toEqual([1, 2, 3, 4]);
		// The live tail run renders 现状 until it settles.
		expect(runs[0]!.idxs).not.toContain(6);
		expect(runs[0]!.idxs).not.toContain(7);
	});

	test("error results still count — the action happened even when it failed", () => {
		const fail = withId({
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "edit",
				content: [{ type: "text", text: "err" }],
				isError: true,
				timestamp: 1,
			},
		});
		const entries = [
			userMsg(),
			assistantToolCall("c1", "edit"),
			fail,
			assistantToolCall("c2", "read"),
			toolResult("c2", "read"),
		];
		const runs = buildToolRuns(entries, false);
		expect(runs[0]!.edits).toBe(1);
		expect(runs[0]!.reads).toBe(1);
	});
});
