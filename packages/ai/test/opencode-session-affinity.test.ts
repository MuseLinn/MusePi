import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@musepi/pi-ai/providers/anthropic";
import { streamGoogle } from "@musepi/pi-ai/providers/google";
import { streamOpenAICompletions } from "@musepi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@musepi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, StreamOptions } from "@musepi/pi-ai/types";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { getInstallId } from "@musepi/pi-utils";

type SessionAffinityOptions = Pick<StreamOptions, "sessionId" | "promptCacheKey" | "headers" | "cacheRetention">;

const CONTEXT: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

function chatSse(): Response {
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

function responsesSse(): Response {
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: "Hello" },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "Hello" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 5,
					output_tokens: 3,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function anthropicSse(): Response {
	const events: Array<[string, unknown]> = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					model: "test",
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			},
		],
		["message_stop", { type: "message_stop" }],
	];
	return new Response(
		`${events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}`).join("\n\n")}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function googleSse(): Response {
	const chunk = {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function drain(stream: AsyncIterable<{ type: string }>): Promise<void> {
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
}

async function captureCompletionsHeaders(
	provider: "opencode-go" | "opencode-zen",
	modelId: string,
	options: SessionAffinityOptions,
): Promise<Headers> {
	const model = getBundledModel(provider, modelId) as Model<"openai-completions">;
	let captured: Headers | undefined;
	const fetchMock: FetchImpl = async (_input, init) => {
		captured ??= new Headers(init?.headers);
		return chatSse();
	};
	await drain(streamOpenAICompletions(model, CONTEXT, { apiKey: "test-key", ...options, fetch: fetchMock }));
	if (!captured) throw new Error("completions request was not dispatched");
	return captured;
}

async function captureResponsesHeaders(
	provider: "opencode-go" | "opencode-zen",
	modelId: string,
	options: SessionAffinityOptions,
): Promise<Headers> {
	const model = getBundledModel(provider, modelId) as Model<"openai-responses">;
	let captured: Headers | undefined;
	const fetchMock: FetchImpl = async (_input, init) => {
		captured ??= new Headers(init?.headers);
		return responsesSse();
	};
	await drain(streamOpenAIResponses(model, CONTEXT, { apiKey: "test-key", ...options, fetch: fetchMock }));
	if (!captured) throw new Error("responses request was not dispatched");
	return captured;
}

async function captureAnthropicHeaders(
	provider: "opencode-go" | "opencode-zen",
	modelId: string,
	options: SessionAffinityOptions,
): Promise<Headers> {
	const model = getBundledModel(provider, modelId) as Model<"anthropic-messages">;
	let captured: Headers | undefined;
	const fetchMock: FetchImpl = async (_input, init) => {
		captured ??= new Headers(init?.headers);
		return anthropicSse();
	};
	await drain(streamAnthropic(model, CONTEXT, { apiKey: "test-key", ...options, fetch: fetchMock }));
	if (!captured) throw new Error("anthropic request was not dispatched");
	return captured;
}

async function captureGoogleHeaders(
	model: Model<"google-generative-ai">,
	options: SessionAffinityOptions,
): Promise<Headers> {
	let captured: Headers | undefined;
	const fetchMock: FetchImpl = async (_input, init) => {
		captured ??= new Headers(init?.headers);
		return googleSse();
	};
	await drain(streamGoogle(model, CONTEXT, { apiKey: "test-key", ...options, fetch: fetchMock }));
	if (!captured) throw new Error("google request was not dispatched");
	return captured;
}

type Transport = {
	api: string;
	provider: "opencode-go" | "opencode-zen";
	modelId: string;
	capture: (
		provider: "opencode-go" | "opencode-zen",
		modelId: string,
		options: SessionAffinityOptions,
	) => Promise<Headers>;
};

const TRANSPORTS: Transport[] = [
	{ api: "openai-completions", provider: "opencode-go", modelId: "glm-5", capture: captureCompletionsHeaders },
	{ api: "openai-completions", provider: "opencode-zen", modelId: "big-pickle", capture: captureCompletionsHeaders },
	{ api: "openai-responses", provider: "opencode-go", modelId: "deepseek-v4-flash", capture: captureResponsesHeaders },
	{ api: "openai-responses", provider: "opencode-zen", modelId: "gpt-5.5", capture: captureResponsesHeaders },
	{ api: "anthropic-messages", provider: "opencode-go", modelId: "minimax-m2.5", capture: captureAnthropicHeaders },
	{
		api: "anthropic-messages",
		provider: "opencode-zen",
		modelId: "claude-haiku-4-5",
		capture: captureAnthropicHeaders,
	},
];

describe("OpenCode session affinity", () => {
	for (const transport of TRANSPORTS) {
		const label = `${transport.provider}/${transport.modelId} ${transport.api}`;

		it(`${label}: sends promptCacheKey as x-opencode-session instead of the child session id`, async () => {
			const headers = await transport.capture(transport.provider, transport.modelId, {
				sessionId: "child-session",
				promptCacheKey: "parent-affinity",
			});

			expect(headers.get("x-opencode-session")).toBe("parent-affinity");
		});

		it(`${label}: falls back to sessionId when promptCacheKey is absent`, async () => {
			const headers = await transport.capture(transport.provider, transport.modelId, {
				sessionId: "parent-session",
			});

			expect(headers.get("x-opencode-session")).toBe("parent-session");
		});

		it(`${label}: keeps session affinity when prompt caching is disabled`, async () => {
			const headers = await transport.capture(transport.provider, transport.modelId, {
				sessionId: "child-session",
				promptCacheKey: "parent-affinity",
				cacheRetention: "none",
			});

			expect(headers.get("x-opencode-session")).toBe("parent-affinity");
		});

		it(`${label}: keeps two affinities on separate sessions`, async () => {
			const first = await transport.capture(transport.provider, transport.modelId, {
				sessionId: "child-session",
				promptCacheKey: "affinity-a",
			});
			const second = await transport.capture(transport.provider, transport.modelId, {
				sessionId: "child-session",
				promptCacheKey: "affinity-b",
			});

			expect(first.get("x-opencode-session")).toBe("affinity-a");
			expect(second.get("x-opencode-session")).toBe("affinity-b");
			expect(first.get("x-opencode-session")).not.toBe(second.get("x-opencode-session"));
		});

		it(`${label}: honors an explicit x-opencode-session header`, async () => {
			const headers = await transport.capture(transport.provider, transport.modelId, {
				sessionId: "child-session",
				promptCacheKey: "parent-affinity",
				headers: { "x-opencode-session": "explicit-affinity" },
			});

			expect(headers.get("x-opencode-session")).toBe("explicit-affinity");
		});

		it(`${label}: falls back to the install id without any session key`, async () => {
			const headers = await transport.capture(transport.provider, transport.modelId, {});

			expect(headers.get("x-opencode-session")).toBe(getInstallId());
		});
	}

	it("keeps the Responses prompt_cache_key disabled while OpenCode affinity stays session-bound", async () => {
		const model = getBundledModel("opencode-zen", "gpt-5.5") as Model<"openai-responses">;
		let capturedHeaders: Headers | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedHeaders ??= new Headers(init?.headers);
			capturedBody ??=
				typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			return responsesSse();
		};
		await drain(
			streamOpenAIResponses(model, CONTEXT, {
				apiKey: "test-key",
				sessionId: "child-session",
				promptCacheKey: "affinity-no-cache",
				cacheRetention: "none",
				fetch: fetchMock,
			}),
		);

		expect(capturedHeaders?.get("x-opencode-session")).toBe("affinity-no-cache");
		expect(capturedBody?.prompt_cache_key).toBeUndefined();
		expect(capturedBody?.prompt_cache_retention).toBeUndefined();
	});

	it("keeps official OpenAI Responses routing and cache headers unchanged", async () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		let captured: Headers | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			captured ??= new Headers(init?.headers);
			return responsesSse();
		};
		await drain(
			streamOpenAIResponses(model, CONTEXT, {
				apiKey: "test-key",
				sessionId: "openai-session",
				promptCacheKey: "openai-cache-key",
				fetch: fetchMock,
			}),
		);

		expect(captured?.get("session_id")).toBe("openai-session");
		expect(captured?.get("x-client-request-id")).toBe("openai-session");
		expect(captured?.has("x-opencode-session")).toBe(false);
	});
});

describe("OpenCode Google transport session affinity", () => {
	const zenGemini = getBundledModel("opencode-zen", "gemini-3-flash") as Model<"google-generative-ai">;
	const googleTransports: Array<{ provider: "opencode-go" | "opencode-zen"; model: Model<"google-generative-ai"> }> = [
		{ provider: "opencode-zen", model: zenGemini },
		// The catalog currently lists Google models only on opencode-zen; keep the
		// shared provider branch covered for opencode-go as well.
		{ provider: "opencode-go", model: { ...zenGemini, provider: "opencode-go" } },
	];

	for (const { provider, model } of googleTransports) {
		const label = `${provider}/${model.id} google-generative-ai`;

		it(`${label}: sends promptCacheKey as x-opencode-session`, async () => {
			const headers = await captureGoogleHeaders(model, {
				sessionId: "child-session",
				promptCacheKey: "parent-affinity",
			});

			expect(headers.get("x-opencode-session")).toBe("parent-affinity");
		});

		it(`${label}: keeps session affinity when prompt caching is disabled`, async () => {
			const headers = await captureGoogleHeaders(model, {
				sessionId: "child-session",
				promptCacheKey: "parent-affinity",
				cacheRetention: "none",
			});

			expect(headers.get("x-opencode-session")).toBe("parent-affinity");
		});

		it(`${label}: honors an explicit x-opencode-session header`, async () => {
			const headers = await captureGoogleHeaders(model, {
				sessionId: "child-session",
				promptCacheKey: "parent-affinity",
				headers: { "x-opencode-session": "explicit-affinity" },
			});

			expect(headers.get("x-opencode-session")).toBe("explicit-affinity");
		});

		it(`${label}: falls back to the install id without any session key`, async () => {
			const headers = await captureGoogleHeaders(model, {});

			expect(headers.get("x-opencode-session")).toBe(getInstallId());
		});
	}

	it("does not add x-opencode-session to official Google requests", async () => {
		const model = getBundledModel("google", "gemini-2.5-flash") as Model<"google-generative-ai">;
		const headers = await captureGoogleHeaders(model, {
			sessionId: "google-session",
			promptCacheKey: "google-cache-key",
		});

		expect(headers.get("x-goog-api-key")).toBe("test-key");
		expect(headers.has("x-opencode-session")).toBe(false);
	});
});
