/**
 * Anthropic on-demand compaction (`compact-2026-09-04`): the request carries the
 * beta field, the streamed signed block becomes the provider payload, and a
 * later request replays that block instead of the summary text.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { convertAnthropicMessages, streamAnthropic } from "@musepi/pi-ai/providers/anthropic";
import { AnthropicMessages } from "@musepi/pi-ai/providers/anthropic-client";
import type { Context, Model } from "@musepi/pi-ai/types";
import { buildModel } from "@musepi/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 64_000,
});

const context: Context = {
	messages: [{ role: "user", content: "Summarize this work", timestamp: Date.now() }],
};

function createMockRequest(events: Record<string, unknown>[]) {
	const response = new Response(null, { status: 200, headers: { "request-id": "req_compaction" } });
	const stream = {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event;
		},
	};
	return {
		async withResponse() {
			return { data: stream, response, request_id: "req_compaction" };
		},
	};
}

function compactionEvents(content: string, signature: string) {
	return [
		{
			type: "message_start",
			message: {
				id: "msg_compaction",
				model: "claude-sonnet-4-5",
				usage: {
					input_tokens: 42_000,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "compaction", content, signature },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "compaction", stop_details: { type: "compaction" } },
			usage: {
				input_tokens: 42_000,
				output_tokens: 900,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		},
		{ type: "message_stop" },
	];
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic native compaction", () => {
	it("requests compaction and persists the signed summary block", async () => {
		let captured: Record<string, unknown> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			captured = params as Record<string, unknown>;
			return createMockRequest(compactionEvents("durable summary", "sig-123")) as never;
		});

		const stream = streamAnthropic(model, context, {
			apiKey: "sk-ant-test",
			maxTokens: 64_000,
			anthropicCompaction: { instructions: "Write a durable checkpoint." },
		});
		for await (const _ of stream) {
			// drain
		}
		const message = await stream.result();

		expect(captured?.compaction).toEqual({ type: "summarize", instructions: "Write a durable checkpoint." });
		expect(message.stopDetails?.type).toBe("compaction");
		expect(message.providerPayload).toMatchObject({
			type: "anthropicCompaction",
			provider: "anthropic",
			content: "durable summary",
			signature: "sig-123",
		});
	});

	it("replays the payload as a compaction block on the next request", () => {
		const params = convertAnthropicMessages(
			[
				{
					role: "user",
					content: "durable summary",
					timestamp: Date.now(),
					providerPayload: {
						type: "anthropicCompaction",
						provider: "anthropic",
						content: "durable summary",
						signature: "sig-123",
						toolChanges: [{ name: "write" }],
					},
				},
			],
			model,
			false,
		);

		expect(params).toHaveLength(1);
		expect(params[0]?.role).toBe("user");
		expect(params[0]?.content).toEqual([
			{
				type: "compaction",
				content: "durable summary",
				signature: "sig-123",
				tool_changes: [{ name: "write" }],
			},
		]);
	});
});
