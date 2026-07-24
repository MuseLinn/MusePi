import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mergeMusepiSettings } from "@musepi/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AdvisorBinding,
	initMusepiAdvisor,
	initMusepiAdvisorForTest,
	musepiAdvisorToolDef,
} from "../src/musepi/advisor-native.ts";

afterEach(() => {
	initMusepiAdvisorForTest(null);
});

function makeMessages(): AgentMessage[] {
	return [
		{ role: "user", content: "refactor the parser", timestamp: 1 } as AgentMessage,
		{
			role: "assistant",
			content: [
				{ type: "text", text: "reading it first" },
				{ type: "toolCall", id: "c1", name: "read", arguments: { path: "parser.ts" } },
			],
			timestamp: 2,
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: "c1",
			content: [{ type: "text", text: "parser source" }],
			isError: false,
			timestamp: 3,
		} as unknown as AgentMessage,
	];
}

function makeBinding(overrides: Partial<AdvisorBinding> = {}): AdvisorBinding {
	return {
		enabled: true,
		maxContextChars: 60_000,
		getMessages: () => makeMessages(),
		resolveModel: async () => ({ model: {} as never, label: "test/reviewer" }),
		complete: async () => "swap the regex for a real tokenizer",
		...overrides,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

async function execute(params: Record<string, unknown>) {
	return musepiAdvisorToolDef.execute("call-1", params, undefined, undefined, {} as never);
}

describe("musepi advisor — gate", () => {
	it("no binding: tool errors politely", async () => {
		initMusepiAdvisorForTest(null);
		await expect(execute({})).rejects.toThrow(/advisor is not enabled/);
	});

	it("init with enabled=false strips the tool from the active set", () => {
		const removed: string[][] = [];
		const session = {
			getActiveToolNames: () => ["read", "advisor", "bash"],
			setActiveToolsByName: (names: string[]) => removed.push(names),
		};
		const settingsManager = {
			getMusepi: () => mergeMusepiSettings({ advisor: { enabled: false } }),
		};
		initMusepiAdvisor(session as never, settingsManager as never);
		expect(removed).toEqual([["read", "bash"]]);
	});

	it("init with defaults binds an enabled session and keeps the tool active", async () => {
		const removed: string[][] = [];
		const session = {
			getActiveToolNames: () => ["read", "advisor"],
			setActiveToolsByName: (names: string[]) => removed.push(names),
			messages: makeMessages(),
			model: { provider: "test", id: "session-model", reasoning: false },
			modelRuntime: {
				getAvailable: async () => [],
				getAuth: async () => undefined,
			},
			agent: { streamFunction: undefined },
		};
		const settingsManager = {
			getMusepi: () => mergeMusepiSettings(undefined),
		};
		initMusepiAdvisor(session as never, settingsManager as never);
		expect(removed).toEqual([]);
		// The tool now executes against the real binding; the model call is
		// unreachable here (no provider), so only check the failure mode is a
		// clean tool error, not a crash of the gate itself.
		await expect(execute({})).rejects.toThrow();
	});
});

describe("musepi advisor — closed loop", () => {
	it("serializes context, resolves the model, and returns the advisory frame", async () => {
		let seenPrompt = "";
		let seenSystem = "";
		initMusepiAdvisorForTest(
			makeBinding({
				complete: async (req) => {
					seenPrompt = req.userPrompt;
					seenSystem = req.systemPrompt;
					return "swap the regex for a real tokenizer";
				},
			}),
		);
		const result = await execute({});
		const text = textOf(result as never);
		expect(text).toBe(
			'<advisory advisor="test/reviewer" guidance="weigh, don\'t blindly obey">\n' +
				"swap the regex for a real tokenizer\n</advisory>",
		);
		// context serialization reached the review model
		expect(seenPrompt).toContain("¶user:refactor the parser");
		expect(seenPrompt).toContain('¶call:read(path="parser.ts")');
		expect(seenPrompt).toContain("<out>\nparser source\n</out>");
		expect(seenPrompt).toContain("Review the transcript above");
		expect(seenSystem).toContain("You are the advisor");
	});

	it("forwards a specific question into the review prompt", async () => {
		let seenPrompt = "";
		initMusepiAdvisorForTest(
			makeBinding({
				complete: async (req) => {
					seenPrompt = req.userPrompt;
					return "yes, with a caveat";
				},
			}),
		);
		await execute({ question: "is the retry safe?" });
		expect(seenPrompt).toContain("The agent asks: is the retry safe?");
	});

	it("empty session context errors instead of calling the model", async () => {
		let called = false;
		initMusepiAdvisorForTest(
			makeBinding({
				getMessages: () => [],
				complete: async () => {
					called = true;
					return "";
				},
			}),
		);
		await expect(execute({})).rejects.toThrow(/nothing to review/);
		expect(called).toBe(false);
	});

	it("model-resolution failure surfaces as a clear tool error", async () => {
		initMusepiAdvisorForTest(
			makeBinding({
				resolveModel: async () => {
					throw new Error('advisor: configured model "x/y" is not in the model registry.');
				},
			}),
		);
		await expect(execute({})).rejects.toThrow(/not in the model registry/);
	});

	it("review-call failure surfaces as a tool error", async () => {
		initMusepiAdvisorForTest(
			makeBinding({
				complete: async () => {
					throw new Error("advisor: review call failed — terminated");
				},
			}),
		);
		await expect(execute({})).rejects.toThrow(/review call failed/);
	});
});
