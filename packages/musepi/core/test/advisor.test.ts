// MusePi core — advisor transcript window / prompts / gate tests.
import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ADVISOR_DEFAULT_MAX_CONTEXT_CHARS,
	ADVISOR_GUIDANCE,
	buildAdvisorTranscript,
	buildAdvisorUserPrompt,
	formatAdvisorResult,
	isAdvisorEnabled,
	resolveAdvisorModelSpec,
} from "../src/advisor/index.ts";
import { mergeMusepiSettings } from "../src/config/schema.ts";
import type { SnapMessage } from "../src/snapcompact/index.ts";

function userMsg(text: string): SnapMessage {
	return { role: "user", content: text };
}

function assistantCall(id: string, name: string, args: Record<string, unknown>, text?: string): SnapMessage {
	const content: SnapMessage["content"] = [];
	if (text) content.push({ type: "text", text });
	content.push({ type: "toolCall", id, name, arguments: args });
	return { role: "assistant", content };
}

function toolResult(id: string, text: string, isError?: boolean): SnapMessage {
	return { role: "toolResult", content: text, toolCallId: id, isError };
}

describe("buildAdvisorTranscript", () => {
	it("serializes a short session in full (¶-scopes, results merged into calls)", () => {
		const transcript = buildAdvisorTranscript([
			userMsg("fix the flaky test"),
			assistantCall("c1", "read", { path: "a.ts" }, "let me look"),
			toolResult("c1", "file contents"),
			{ role: "assistant", content: [{ type: "text", text: "found it" }] },
		]);
		assert.match(transcript, /¶user:fix the flaky test/);
		assert.match(transcript, /¶ai:let me look/);
		assert.match(transcript, /¶call:read\(path="a\.ts"\)/);
		assert.match(transcript, /<out>\nfile contents\n<\/out>/);
		assert.match(transcript, /¶ai:found it/);
		assert.ok(!transcript.includes("elided (~"));
	});

	it("over budget: keeps the first ask as anchor, elides the middle, keeps the tail", () => {
		const messages: SnapMessage[] = [userMsg("THE ORIGINAL ASK")];
		for (let i = 0; i < 60; i++) {
			messages.push(assistantCall(`c${i}`, "bash", { command: `step-${i} ${"x".repeat(400)}` }));
			messages.push(toolResult(`c${i}`, `output-${i} ${"y".repeat(400)}`));
		}
		messages.push({ role: "assistant", content: [{ type: "text", text: "THE NEWEST REPLY" }] });

		const transcript = buildAdvisorTranscript(messages, { maxChars: 4_000 });
		assert.match(transcript, /¶user:THE ORIGINAL ASK/);
		assert.match(transcript, /\[…earlier transcript elided \(~\d+ chars\)…\]/);
		assert.match(transcript, /THE NEWEST REPLY/);
		assert.ok(transcript.length <= 4_200, `expected ≤ head+marker+budget, got ${transcript.length}`);
		// middle gone
		assert.ok(!transcript.includes("step-10"));
	});

	it("drops contextually useless tool results with their calls", () => {
		const transcript = buildAdvisorTranscript([
			userMsg("hi"),
			assistantCall("c1", "advise", { note: "noop" }),
			{ role: "toolResult", content: "Recorded.", toolCallId: "c1", useless: true },
			assistantCall("c2", "read", { path: "b.ts" }),
			toolResult("c2", "real output"),
		]);
		assert.ok(!transcript.includes("advise("));
		assert.match(transcript, /read\(path="b\.ts"\)/);
	});

	it("respects a custom tool-result cap", () => {
		const transcript = buildAdvisorTranscript(
			[assistantCall("c1", "bash", { command: "ls" }), toolResult("c1", "z".repeat(500))],
			{ toolResultMaxChars: 100 },
		);
		assert.match(transcript, /elided/);
		assert.ok(transcript.length < 500);
	});

	it("applies the default budget constant when options are omitted", () => {
		// User text is not per-message capped, so one huge user message
		// pushes the serialization past the default budget.
		const huge = "x".repeat(ADVISOR_DEFAULT_MAX_CONTEXT_CHARS + 10_000);
		const transcript = buildAdvisorTranscript([userMsg("ask"), userMsg(huge)]);
		assert.match(transcript, /earlier transcript elided/);
	});
});

describe("buildAdvisorUserPrompt", () => {
	it("general review without a question", () => {
		const prompt = buildAdvisorUserPrompt({ transcript: "¶user:hi" });
		assert.match(prompt, /<transcript>\n¶user:hi\n<\/transcript>/);
		assert.match(prompt, /Review the transcript above/);
		assert.ok(!prompt.includes("The agent asks"));
	});

	it("specific question is appended and trimmed", () => {
		const prompt = buildAdvisorUserPrompt({ transcript: "T", question: "  is the retry safe?  " });
		assert.match(prompt, /The agent asks: is the retry safe\?/);
	});
});

describe("formatAdvisorResult", () => {
	it("wraps guidance in the advisory frame with the guidance cue", () => {
		const out = formatAdvisorResult("  looks fine  ", { advisor: "openai/gpt-5" });
		assert.equal(
			out,
			`<advisory advisor="openai/gpt-5" guidance="${ADVISOR_GUIDANCE}">\nlooks fine\n</advisory>`,
		);
	});

	it("escapes quotes in the advisor label", () => {
		const out = formatAdvisorResult("x", { advisor: 'bad"label' });
		assert.match(out, /advisor="bad&quot;label"/);
	});
});

describe("gate + model-spec chain", () => {
	it("enabled by default; explicit false disables", () => {
		assert.equal(isAdvisorEnabled(undefined), true);
		assert.equal(isAdvisorEnabled({}), true);
		assert.equal(isAdvisorEnabled({ enabled: false }), false);
	});

	it("model chain: advisor.model → roles.advisor → roles.default → empty", () => {
		assert.equal(
			resolveAdvisorModelSpec({ model: "a/m1" }, { advisor: "b/m2", default: "c/m3" }),
			"a/m1",
		);
		assert.equal(resolveAdvisorModelSpec({ model: "  " }, { advisor: "b/m2", default: "c/m3" }), "b/m2");
		assert.equal(resolveAdvisorModelSpec(undefined, { default: "c/m3" }), "c/m3");
		assert.equal(resolveAdvisorModelSpec(undefined, undefined), "");
	});

	it("settings schema carries musepi.advisor defaults and merges overrides", () => {
		const defaults = mergeMusepiSettings(undefined);
		assert.deepEqual(defaults.advisor, { enabled: true, model: "", maxContextChars: 60_000 });

		const merged = mergeMusepiSettings({ advisor: { enabled: false, model: "openai/gpt-5:high", maxContextChars: 10_000 } });
		assert.deepEqual(merged.advisor, { enabled: false, model: "openai/gpt-5:high", maxContextChars: 10_000 });

		// mistyped fields fall back to defaults
		const mistyped = mergeMusepiSettings({ advisor: { enabled: "yes", maxContextChars: "big" } as never });
		assert.deepEqual(mistyped.advisor, { enabled: true, model: "", maxContextChars: 60_000 });
	});
});
