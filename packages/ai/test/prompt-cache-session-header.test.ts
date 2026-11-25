import { describe, expect, test } from "bun:test";
import { resolveOpenAIRequestSetup } from "@musepi/pi-ai/providers/openai-shared";
import type { Context } from "@musepi/pi-ai/types";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function model(header: string) {
	return {
		provider: "magpie",
		id: "group/deepseek-v4.1-flash",
		baseUrl: "http://127.0.0.1:3425",
		api: "openai-completions" as const,
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		input: ["text"] as const,
		compat: { promptCacheSessionHeader: header },
	} as never;
}

describe("prompt cache session header", () => {
	test("a custom provider names its own affinity header", () => {
		// MusePi used to accept only xAI's x-grok-conv-id, so a local gateway that
		// pins sessions by x-session-affinity could never be told to.
		const setup = resolveOpenAIRequestSetup(model("x-session-affinity"), {
			apiKey: "k",
			messages: context.messages,
			promptCacheSessionId: "pc_abc",
		} as never);
		expect(setup.headers["x-session-affinity"]).toBe("pc_abc");
	});

	test("an existing caller header wins over the derived one", () => {
		const setup = resolveOpenAIRequestSetup(model("x-session-affinity"), {
			apiKey: "k",
			messages: context.messages,
			promptCacheSessionId: "pc_abc",
			extraHeaders: { "X-Session-Affinity": "caller" },
		} as never);
		const names = Object.keys(setup.headers).map(name => name.toLowerCase());
		expect(names.filter(name => name === "x-session-affinity")).toHaveLength(1);
		expect(setup.headers["X-Session-Affinity"]).toBe("caller");
	});

	test("an invalid header name is dropped instead of breaking every request", () => {
		const setup = resolveOpenAIRequestSetup(model("x session\nX-Injected: 1"), {
			apiKey: "k",
			messages: context.messages,
			promptCacheSessionId: "pc_abc",
		} as never);
		expect(Object.keys(setup.headers).some(name => name.includes(" "))).toBe(false);
	});

	test("no header is written without a session id", () => {
		const setup = resolveOpenAIRequestSetup(model("x-session-affinity"), {
			apiKey: "k",
			messages: context.messages,
		} as never);
		expect(setup.headers["x-session-affinity"]).toBeUndefined();
	});
});
