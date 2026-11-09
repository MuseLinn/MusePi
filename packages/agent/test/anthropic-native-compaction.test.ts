/**
 * Anthropic native compaction through `compact()`: the provider's signed block
 * is persisted as the compaction payload and the textual summary is its content.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getPreservedAnthropicCompactionData,
	shouldUseAnthropicNativeCompaction,
} from "@musepi/pi-agent-core/compaction";
import { AnthropicMessages } from "@musepi/pi-ai/providers/anthropic-client";
import type { Model } from "@musepi/pi-ai/types";
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
		{ type: "content_block_start", index: 0, content_block: { type: "compaction", content, signature } },
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

function preparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-1",
		messagesToSummarize: [{ role: "user", content: "long history", timestamp: 1 }],
		turnPrefixMessages: [],
		recentMessages: [{ role: "user", content: "recent", timestamp: 2 }],
		isSplitTurn: false,
		tokensBefore: 100_000,
		fileOps: createFileOps(),
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("anthropic native compaction through compact()", () => {
	it("selects the native lane only for first-party Anthropic models", () => {
		expect(shouldUseAnthropicNativeCompaction(model)).toBe(true);
	});

	it("selects the native lane for Bedrock Anthropic models", () => {
		const bedrock = buildModel({
			id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			name: "Claude Sonnet 4.5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		}) as Model;
		expect(shouldUseAnthropicNativeCompaction(bedrock)).toBe(true);
	});

	it("persists the signed block and uses its content as the summary", async () => {
		let captured: Record<string, unknown> | undefined;
		vi.spyOn(AnthropicMessages.prototype, "create").mockImplementation((params: unknown) => {
			captured = params as Record<string, unknown>;
			return createMockRequest(compactionEvents("durable summary", "sig-abc")) as never;
		});

		const result = await compact(preparation(), model, "sk-ant-test");

		expect(captured?.compaction).toMatchObject({ type: "summarize" });
		expect(result.summary).toBe("durable summary");
		const native = getPreservedAnthropicCompactionData(result.preserveData);
		expect(native).toMatchObject({
			provider: "anthropic",
			content: "durable summary",
			signature: "sig-abc",
		});
	});
});
