import { describe, expect, test, vi } from "bun:test";
import { streamOpenAICompletions } from "@musepi/pi-ai/providers/openai-completions";
import type { FetchImpl } from "@musepi/pi-ai/types";
import { buildModel } from "@musepi/pi-catalog/build";
import { buildOpenAICompat } from "@musepi/pi-catalog/compat/openai";

function chatModel(supportsPromptCacheKey: boolean) {
	return buildModel({
		id: "group/deepseek-v4.1-flash",
		name: "routing group",
		api: "openai-completions",
		provider: "magpie",
		baseUrl: "http://127.0.0.1:3425",
		input: ["text"],
		reasoning: false,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		compat: { supportsPromptCacheKey },
	});
}

function sse(): Response {
	const chunk = (delta: unknown, finish: string | null) =>
		JSON.stringify({
			id: "x",
			object: "chat.completion.chunk",
			created: 0,
			choices: [{ index: 0, delta, finish_reason: finish }],
		});
	return new Response(`data: ${chunk({ content: "ok" }, null)}\n\ndata: ${chunk({}, "stop")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function bodyFor(supportsPromptCacheKey: boolean): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> = {};
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		captured = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return sse();
	});
	await streamOpenAICompletions(
		chatModel(supportsPromptCacheKey),
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
		{ apiKey: "k", fetch: fetchMock as unknown as FetchImpl, sessionId: "session-1" },
	).result();
	return captured;
}

describe("prompt_cache_key is opt-in per provider", () => {
	test("a provider that opts in sends the session key", async () => {
		const body = await bodyFor(true);
		expect(typeof body.prompt_cache_key).toBe("string");
	});

	test("everyone else sends no such field", async () => {
		// Strict proxies 400 on unknown body fields, so silence is the default.
		const body = await bodyFor(false);
		expect(body.prompt_cache_key).toBeUndefined();
	});
});

describe("the catalog turns the flag on only where it is known to work", () => {
	test("kimi-code sends it", () => {
		const compat = buildOpenAICompat({
			provider: "kimi-code",
			id: "kimi-k2.6",
			baseUrl: "https://api.kimi.com/coding",
			api: "openai-completions",
		} as never);
		expect(compat.supportsPromptCacheKey).toBe(true);
	});

	test("an ordinary OpenAI-compatible provider does not", () => {
		const compat = buildOpenAICompat({
			provider: "magpie",
			id: "group/deepseek-v4.1-flash",
			baseUrl: "http://127.0.0.1:3425",
			api: "openai-completions",
		} as never);
		expect(compat.supportsPromptCacheKey).toBe(false);
	});

	test("a custom provider can override it on", () => {
		const compat = buildOpenAICompat({
			provider: "magpie",
			id: "group/deepseek-v4.1-flash",
			baseUrl: "http://127.0.0.1:3425",
			api: "openai-completions",
			compat: { supportsPromptCacheKey: true },
		} as never);
		expect(compat.supportsPromptCacheKey).toBe(true);
	});
});
