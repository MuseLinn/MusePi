import { describe, expect, it } from "bun:test";
import { streamGoogle } from "@musepi/pi-ai/providers/google";
import type { AssistantMessageEvent, Context, FetchImpl, Model } from "@musepi/pi-ai/types";
import { buildModel } from "@musepi/pi-catalog/build";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function sseStop(): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<void> {
	for await (const _ of stream) {
		// consume
	}
}

function modelWithBaseUrl(baseUrl: string): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

async function requestUrl(baseUrl: string): Promise<string> {
	let captured = "";
	const fetch: FetchImpl = async url => {
		captured = String(url);
		return sseStop();
	};
	await drain(streamGoogle(modelWithBaseUrl(baseUrl), context, { apiKey: "test-key", fetch }));
	return captured;
}

describe("google generative language base URL", () => {
	it("appends the API version to a host-only proxy base", async () => {
		expect(await requestUrl("https://proxy.example.com/gemini")).toStartWith(
			"https://proxy.example.com/gemini/v1beta/models/gemini-3-flash:streamGenerateContent",
		);
	});

	it("keeps a base that already carries the version segment", async () => {
		expect(await requestUrl("https://proxy.example.com/gemini/v1beta")).toStartWith(
			"https://proxy.example.com/gemini/v1beta/models/gemini-3-flash:streamGenerateContent",
		);
	});

	it("normalizes a trailing slash after the version segment", async () => {
		expect(await requestUrl("https://proxy.example.com/gemini/v1beta/")).toStartWith(
			"https://proxy.example.com/gemini/v1beta/models/gemini-3-flash:streamGenerateContent",
		);
	});

	it("falls back to the public endpoint when no base is configured", async () => {
		expect(await requestUrl("")).toStartWith(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:streamGenerateContent",
		);
	});
});
