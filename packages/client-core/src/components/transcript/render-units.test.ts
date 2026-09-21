import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import {
	buildTurnRenderUnits,
	type ChatLoadingVisibility,
	classifyTranscriptRow,
	hasPendingAsk,
	shouldShowChatLoading,
} from "./render-units";

/** Minimal EntryBase fields shared by every SessionEntry. */
const base = { parentId: null, timestamp: "0" };

let seq = 0;
/** Fresh id per fixture so keys are stable within a test but unique across. */
function withId(overrides: object): SessionEntry {
	return { ...base, id: `e${++seq}`, ...overrides } as unknown as SessionEntry;
}

const userMsg = (text = "hi"): SessionEntry =>
	withId({ type: "message", message: { role: "user", content: text, timestamp: 1 } });

const assistantText = (text = "ok"): SessionEntry =>
	withId({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: 1 } });

/** thinking-only / toolCall-only assistant row → classified "work". */
const assistantThinking = (): SessionEntry =>
	withId({
		type: "message",
		message: { role: "assistant", content: [{ type: "thinking", text: "hmm" }], timestamp: 1 },
	});

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

const bashExecution = (): SessionEntry =>
	withId({
		type: "message",
		message: { role: "bashExecution", command: "ls", output: "o", exitCode: 0, timestamp: 1 },
	});

const custom = (customType: string, display = true): SessionEntry =>
	withId({ type: "custom_message", customType, content: "x", display });

const compaction = (): SessionEntry =>
	withId({ type: "compaction", summary: "s", firstKeptEntryId: "k", tokensBefore: 1 });

describe("classifyTranscriptRow", () => {
	test("roles map to user / assistantText / work", () => {
		expect(classifyTranscriptRow(userMsg())).toBe("user");
		expect(classifyTranscriptRow(assistantText())).toBe("assistantText");
		expect(classifyTranscriptRow(assistantThinking())).toBe("work");
		expect(classifyTranscriptRow(assistantToolCall("c1"))).toBe("work");
		expect(classifyTranscriptRow(toolResult("c1"))).toBe("work");
		expect(classifyTranscriptRow(bashExecution())).toBe("work");
	});

	test("assistant message with empty text block is work, not reply", () => {
		const empty = withId({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "   " }], timestamp: 1 },
		});
		expect(classifyTranscriptRow(empty)).toBe("work");
	});

	test("custom messages split into tail / hook / custom", () => {
		expect(classifyTranscriptRow(custom("retry_failure"))).toBe("tail");
		expect(classifyTranscriptRow(custom("async-result"))).toBe("tail");
		expect(classifyTranscriptRow(custom("hook"))).toBe("hook");
		expect(classifyTranscriptRow(custom("hook:lint-check"))).toBe("hook");
		expect(classifyTranscriptRow(custom("advisor"))).toBe("custom");
		expect(classifyTranscriptRow(custom("irc:incoming"))).toBe("custom");
	});

	test("structural entries are boundary", () => {
		expect(classifyTranscriptRow(compaction())).toBe("boundary");
		expect(classifyTranscriptRow(withId({ type: "model_change", model: "p/m" }))).toBe("boundary");
	});
});

describe("buildTurnRenderUnits", () => {
	test("empty transcript yields no units", () => {
		expect(buildTurnRenderUnits([], true)).toEqual([]);
		expect(buildTurnRenderUnits([], false)).toEqual([]);
	});

	test("single text-only turn: reply anchored, no work rows", () => {
		const entries = [userMsg(), assistantText("answer")];
		const [u] = buildTurnRenderUnits(entries, false);
		expect(u).toMatchObject({
			turnIndex: 0,
			startIdx: 0,
			endIdx: 1,
			replyIdx: 1,
			workIdxs: [],
			tailIdxs: [],
			hookIdxs: [],
			isLastTurn: true,
			isRunning: false,
		});
		expect(u!.key).toBe(entries[0]!.id);
	});

	test("work/tail/hook rows bucket into the right turn, in CLI order", () => {
		const entries = [
			userMsg(),
			assistantThinking(),
			assistantToolCall("c1"),
			toolResult("c1"),
			bashExecution(),
			custom("async-result"),
			custom("hook:lint-check"),
			assistantText("done"),
			userMsg("next"),
			assistantText("second answer"),
		];
		const units = buildTurnRenderUnits(entries, false);
		expect(units).toHaveLength(2);
		const [t1, t2] = units;
		expect(t1).toMatchObject({
			startIdx: 0,
			endIdx: 7,
			replyIdx: 7,
			workIdxs: [1, 2, 3, 4],
			tailIdxs: [5],
			hookIdxs: [6],
			isLastTurn: false,
			isRunning: false,
		});
		expect(t2).toMatchObject({ startIdx: 8, endIdx: 9, replyIdx: 9, isLastTurn: true });
	});

	test("turn runs to the row before the next user message (openchamber model)", () => {
		// Rows AFTER the reply but BEFORE the next prompt belong to turn 1 —
		// same rule round-collapse documents (endIdx inclusive).
		const entries = [userMsg(), assistantText("reply"), bashExecution(), userMsg(), assistantText("r2")];
		const [t1] = buildTurnRenderUnits(entries, false);
		expect(t1).toMatchObject({ endIdx: 2, replyIdx: 1, workIdxs: [2] });
	});

	test("in-flight tail turn isRunning only while working", () => {
		const entries = [userMsg(), assistantThinking()];
		expect(buildTurnRenderUnits(entries, true)[0]!.isRunning).toBe(true);
		expect(buildTurnRenderUnits(entries, false)[0]!.isRunning).toBe(false);
		// An earlier completed turn never runs.
		const two = [userMsg(), assistantText("a"), userMsg(), assistantThinking()];
		const units = buildTurnRenderUnits(two, true);
		expect(units[0]!.isRunning).toBe(false);
		expect(units[1]!.isRunning).toBe(true);
	});

	test("tool-only turn has no reply yet (replyIdx -1)", () => {
		const entries = [userMsg(), assistantToolCall("c1"), toolResult("c1")];
		const [u] = buildTurnRenderUnits(entries, true);
		expect(u!.replyIdx).toBe(-1);
		expect(u!.workIdxs).toEqual([1, 2]);
	});

	test("displayed advisor note starts its own turn (round-collapse parity)", () => {
		const entries = [userMsg(), assistantText("a"), custom("advisor"), assistantToolCall("c9"), toolResult("c9")];
		const units = buildTurnRenderUnits(entries, false);
		expect(units).toHaveLength(2);
		expect(units[1]!.startIdx).toBe(2);
		expect(units[1]!.workIdxs).toEqual([3, 4]);
	});

	test("rows before the first turn start belong to no unit", () => {
		const entries = [compaction(), userMsg(), assistantText("a")];
		const [u] = buildTurnRenderUnits(entries, false);
		expect(u!.startIdx).toBe(1);
		expect(u!.turnIndex).toBe(0);
	});
});

describe("hasPendingAsk", () => {
	test("no ask calls → false", () => {
		expect(hasPendingAsk([userMsg(), assistantToolCall("c1"), toolResult("c1")])).toBe(false);
		expect(hasPendingAsk([])).toBe(false);
	});

	test("answered ask → false", () => {
		const entries = [userMsg(), assistantToolCall("q1", "ask"), toolResult("q1", "ask")];
		expect(hasPendingAsk(entries)).toBe(false);
	});

	test("unmatched ask toolCall → true (question awaiting the user)", () => {
		const entries = [userMsg(), assistantToolCall("q1", "ask")];
		expect(hasPendingAsk(entries)).toBe(true);
		// A LATER answered ask does not retro-answer an earlier unmatched one
		// when ids differ.
		const two = [userMsg(), assistantToolCall("q1", "ask"), toolResult("q2", "ask")];
		expect(hasPendingAsk(two)).toBe(true);
	});
});

describe("shouldShowChatLoading (design doc §B judgment table)", () => {
	const base: ChatLoadingVisibility = { working: true };

	test("plain streaming → visible", () => {
		expect(shouldShowChatLoading(base)).toBe(true);
	});

	test("each pending condition suppresses it", () => {
		expect(shouldShowChatLoading({ ...base, approvalPending: true })).toBe(false);
		expect(shouldShowChatLoading({ ...base, askPending: true })).toBe(false);
		expect(shouldShowChatLoading({ ...base, compacting: true })).toBe(false);
		expect(shouldShowChatLoading({ ...base, goalVerifierActive: true })).toBe(false);
	});

	test("not working → hidden regardless", () => {
		expect(shouldShowChatLoading({ working: false })).toBe(false);
		expect(shouldShowChatLoading({ working: false, approvalPending: true })).toBe(false);
	});

	test("suppression clears when the pending condition resolves", () => {
		expect(shouldShowChatLoading({ working: true, approvalPending: false, askPending: false })).toBe(true);
	});
});

describe("buildTurnRenderUnits model tracking", () => {
	test("fallback model applies to turns before any model_change", () => {
		const entries = [userMsg(), assistantText("a")];
		const [u] = buildTurnRenderUnits(entries, false, { fallbackModel: "anthropic/k2.5" });
		expect(u!.model).toBe("k2.5");
	});

	test("no fallback and no model_change → model undefined", () => {
		const entries = [userMsg(), assistantText("a")];
		const [u] = buildTurnRenderUnits(entries, false);
		expect(u!.model).toBeUndefined();
	});

	test("model_change folds forward to later turns only", () => {
		const entries = [
			userMsg(),
			assistantText("a"),
			userMsg("next"),
			withId({ type: "model_change", model: "zai/glm-5" }),
			assistantText("b"),
		];
		const units = buildTurnRenderUnits(entries, false);
		expect(units[0]!.model).toBeUndefined();
		expect(units[1]!.model).toBe("glm-5");
	});

	test("bare model id without provider stays as-is", () => {
		const entries = [withId({ type: "model_change", model: "k2.5" }), userMsg(), assistantText("a")];
		const [u] = buildTurnRenderUnits(entries, false);
		expect(u!.model).toBe("k2.5");
	});
});
