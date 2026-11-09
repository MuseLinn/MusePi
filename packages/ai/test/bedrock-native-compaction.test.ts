/**
 * Bedrock Anthropic on-demand compaction: ordinary turns stay on Converse, while
 * `anthropicCompaction` sends an InvokeModelWithResponseStream side request and
 * decodes the base64 Anthropic events into the signed provider payload.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { streamBedrock } from "@musepi/pi-ai/providers/amazon-bedrock";
import { crc32 } from "@musepi/pi-ai/providers/aws-eventstream";
import type { Context, FetchImpl, Model } from "@musepi/pi-ai/types";
import { buildModel } from "@musepi/pi-catalog/build";

const model: Model<"bedrock-converse-stream"> = buildModel({
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
});

const context: Context = { messages: [{ role: "user", content: "summarize", timestamp: 0 }] };

async function withSkippedAuth<T>(body: () => Promise<T>): Promise<T> {
	const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
	const originalBearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	try {
		return await body();
	} finally {
		if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
		else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
		if (originalBearerToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		else process.env.AWS_BEARER_TOKEN_BEDROCK = originalBearerToken;
	}
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerParts: Uint8Array[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const nameBytes = new TextEncoder().encode(name);
		const valueBytes = new TextEncoder().encode(value);
		const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
		const partView = new DataView(part.buffer);
		let cursor = 0;
		partView.setUint8(cursor, nameBytes.length);
		cursor += 1;
		part.set(nameBytes, cursor);
		cursor += nameBytes.length;
		partView.setUint8(cursor, 7);
		cursor += 1;
		partView.setUint16(cursor, valueBytes.length, false);
		cursor += 2;
		part.set(valueBytes, cursor);
		headerParts.push(part);
	}
	const headerLength = headerParts.reduce((total, part) => total + part.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let offset = 0;
	for (const part of headerParts) {
		headerBytes.set(part, offset);
		offset += part.length;
	}
	const totalLength = 12 + headerLength + payload.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function chunkFrame(event: Record<string, unknown>): Uint8Array {
	const bytes = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
	return encodeFrame(
		{ ":message-type": "event", ":event-type": "chunk" },
		new TextEncoder().encode(JSON.stringify({ bytes })),
	);
}

function compactionFetch(seen: { body?: unknown }): FetchImpl {
	const events = [
		{ type: "message_start", message: { usage: { input_tokens: 42_000 } } },
		{
			type: "content_block_start",
			content_block: { type: "compaction", content: "bedrock summary", signature: "sig-b" },
		},
		{ type: "content_block_stop" },
		{ type: "message_delta", usage: { output_tokens: 900 } },
		{ type: "message_stop" },
	];
	const frames = events.map(chunkFrame);
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			const raw = init?.body;
			seen.body =
				typeof raw === "string"
					? JSON.parse(raw)
					: raw instanceof Uint8Array
						? JSON.parse(new TextDecoder().decode(raw))
						: undefined;
			let index = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (index < frames.length) controller.enqueue(frames[index++]!);
					else controller.close();
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
		},
		{ preconnect: fetch.preconnect },
	);
}

afterEach(() => {
	// environment is restored by withSkippedAuth
});

describe("bedrock anthropic native compaction", () => {
	it("sends the compaction side request and decodes the signed summary", async () => {
		const seen: { body?: unknown } = {};
		await withSkippedAuth(async () => {
			const stream = streamBedrock(model, context, {
				region: "us-east-1",
				maxTokens: 64_000,
				anthropicCompaction: { instructions: "Write a durable checkpoint." },
				fetch: compactionFetch(seen),
			});
			for await (const _ of stream) {
				// drain
			}
			const message = await stream.result();
			expect(message.providerPayload).toMatchObject({
				type: "anthropicCompaction",
				provider: "amazon-bedrock",
				content: "bedrock summary",
				signature: "sig-b",
			});
			expect(message.stopDetails?.type).toBe("compaction");
		});

		expect(seen.body).toMatchObject({
			anthropic_version: "bedrock-2023-05-31",
			compaction: { type: "summarize", instructions: "Write a durable checkpoint." },
		});
	});
});
