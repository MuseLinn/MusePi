import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@musepi/pi-agent-core";
import {
	PROMPT_SUGGESTION_MAX_CHARS,
	promptSuggestionText,
	turnAllowsPromptSuggestion,
} from "../src/session/prompt-suggestion";

/** Policy only: the model call, timing and delivery belong to the bundled plugin. */

function assistant(stopReason: string): AgentMessage {
	return { role: "assistant", content: [], stopReason } as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text } as unknown as AgentMessage;
}

describe("promptSuggestionText", () => {
	test("keeps the message content and trims only the edges", () => {
		expect(promptSuggestionText("  Run the tests.\n")).toBe("Run the tests.");
		expect(promptSuggestionText("\n\t 再跑一次 构建 \n")).toBe("再跑一次 构建");
	});

	test("empty output and the literal null decline the suggestion", () => {
		for (const raw of ["", "   ", "\n\n", "null", " null "]) {
			expect(promptSuggestionText(raw)).toBeNull();
		}
	});

	test("only the bare word null declines; a sentence containing it does not", () => {
		expect(promptSuggestionText("null is fine here")).toBe("null is fine here");
		expect(promptSuggestionText("NONE")).toBe("NONE");
	});

	test("structured-looking output is preserved rather than repaired", () => {
		expect(promptSuggestionText('{"suggestion":"Run the tests"}')).toBe('{"suggestion":"Run the tests"}');
	});
});

describe("promptSuggestionText — structured answer", () => {
	test("a yes answer yields its message", () => {
		expect(promptSuggestionText('{"show":"yes","message":"跑一下测试"}')).toBe("跑一下测试");
	});

	test("a fenced yes answer is unwrapped", () => {
		expect(promptSuggestionText('```json\n{"show":"yes","message":"commit this"}\n```')).toBe("commit this");
	});

	test("a no answer declines, matching the bare null", () => {
		expect(promptSuggestionText('{"show":"no","message":""}')).toBeNull();
		expect(promptSuggestionText('{"show":"no","message":"ignore me"}')).toBeNull();
	});

	test("an object without a show field falls back to plain text", () => {
		expect(promptSuggestionText('{"suggestion":"Run the tests"}')).toBe('{"suggestion":"Run the tests"}');
	});

	test("malformed JSON falls back to plain text instead of throwing", () => {
		expect(promptSuggestionText('{"show":"yes"')).toBe('{"show":"yes"');
	});

	test("a yes answer is capped at the instruction's own limit", () => {
		const long = "x".repeat(400);
		expect(promptSuggestionText(`{"show":"yes","message":"${long}"}`)).toHaveLength(PROMPT_SUGGESTION_MAX_CHARS);
	});
});

describe("turnAllowsPromptSuggestion", () => {
	test("a naturally completed turn qualifies", () => {
		expect(turnAllowsPromptSuggestion([user("fix it"), assistant("stop")])).toBe(true);
	});

	test("aborted and errored turns do not qualify", () => {
		expect(turnAllowsPromptSuggestion([user("fix it"), assistant("aborted")])).toBe(false);
		expect(turnAllowsPromptSuggestion([user("fix it"), assistant("error")])).toBe(false);
	});

	test("an earlier reply cannot qualify a turn that ended elsewhere", () => {
		expect(turnAllowsPromptSuggestion([assistant("stop"), user("fix it"), assistant("aborted")])).toBe(false);
	});

	test("a turn with no assistant reply does not qualify", () => {
		expect(turnAllowsPromptSuggestion([])).toBe(false);
		expect(turnAllowsPromptSuggestion([user("fix it")])).toBe(false);
	});
});
