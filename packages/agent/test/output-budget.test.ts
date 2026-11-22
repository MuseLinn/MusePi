import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context, Message, Model } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { countContextOverrun, MIN_FITTED_OUTPUT_TOKENS, OUTPUT_FIT_HEADWAY_TOKENS } from "../src/output-budget";
import { Tokenizer } from "../src/tokenizer";

// Contract: `countContextOverrun` refuses a handoff only when the prompt alone
// leaves no room for the smallest output a request keeps. It counts locally
// (never trusting a usage report), adds no tokenizer margin, and stops at the
// first message past the window — so a near-full request is still sent and
// the provider decides.
// Test-env token counts are bytes/4, so `tokens * 4` ASCII bytes is `tokens`.
function userOf(tokens: number, timestamp: number): Message {
	return { role: "user", content: "x".repeat(tokens * 4), timestamp };
}

/** Settled assistant turn whose provider-reported prompt was `promptTokens`. */
function reported(promptTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: promptTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: promptTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
const model: Model = { ...bundled, contextWindow: 200_000, maxTokens: 8_192 };

describe("countContextOverrun", () => {
	const tokenizer = new Tokenizer();

	test("refuses only a prompt that leaves no room for the minimum fitted output", () => {
		const minimumRequest = OUTPUT_FIT_HEADWAY_TOKENS + MIN_FITTED_OUTPUT_TOKENS;
		const context: Context = { messages: [userOf(100_000, 1)] };
		const exact = { ...model, contextWindow: 100_000 + minimumRequest };
		expect(countContextOverrun(context, exact, tokenizer)).toBeUndefined();
		expect(countContextOverrun(context, { ...exact, contextWindow: exact.contextWindow - 1 }, tokenizer)).toBe(
			100_000,
		);
	});

	test("counts history a stale usage report understates", () => {
		// History re-expanded behind a native compaction the model cannot replay:
		// the newest report still describes the small compacted prefix that was sent.
		const context: Context = { messages: [userOf(300_000, 1), reported(10_000, 2)] };
		const result = countContextOverrun(context, model, tokenizer);
		expect(result).toBeDefined();
		expect(result!).toBeGreaterThanOrEqual(300_000);
	});

	test("allows a handoff when the model declares no window", () => {
		const unwindowed: Model = { ...model, contextWindow: 0 };
		expect(countContextOverrun({ messages: [userOf(500_000, 1)] }, unwindowed, tokenizer)).toBeUndefined();
	});

	test("counts the framing prefix outside messages", () => {
		// The system prompt alone busts the window; the small message tail is never
		// reached, so the verdict must come from the framing count.
		const context: Context = {
			systemPrompt: ["x".repeat(800_000)],
			messages: [userOf(10, 1)],
		};
		expect(countContextOverrun(context, model, tokenizer)).toBeGreaterThanOrEqual(200_000);
	});
});
