import { describe, expect, it } from "bun:test";
import { VoiceFrontendClient } from "@musepi/pi-coding-agent/voice/frontend/client";
import type {
	VoiceFrontendTransport,
	VoiceFrontendWorkerInbound,
	VoiceFrontendWorkerOutbound,
} from "@musepi/pi-coding-agent/voice/frontend/protocol";

class FakeTransport implements VoiceFrontendTransport {
	readonly messages: VoiceFrontendWorkerInbound[] = [];
	terminated = false;
	private handler: ((message: VoiceFrontendWorkerOutbound) => void) | null = null;
	constructor(private readonly respond: (message: VoiceFrontendWorkerInbound) => VoiceFrontendWorkerOutbound) {}
	send(message: VoiceFrontendWorkerInbound): void {
		this.messages.push(message);
		this.handler?.(this.respond(message));
	}
	onMessage(handler: (message: VoiceFrontendWorkerOutbound) => void): () => void {
		this.handler = handler;
		return () => {
			this.handler = null;
		};
	}
	terminate(): void {
		this.terminated = true;
	}
}

const baseInput = {
	audio: new Float32Array([0.1, 0.2]),
	sampleRate: 16_000 as const,
	targetMs: 1500,
	speakerMode: "prefer" as const,
	enhanceAudio: true,
	enrollment: [],
	acceptThreshold: 0.7,
	rejectThreshold: 0.5,
};

describe("voice frontend client", () => {
	it("passes through off mode without enhancement or speaker verification", async () => {
		const transport = new FakeTransport(message => {
			const request = message as { type: string; id: string; audio: Float32Array };
			return {
				type: "result",
				id: request.id,
				audio: request.audio,
				state: "accept",
				score: null,
				enhanced: false,
				segmentId: 0,
			};
		});
		const client = new VoiceFrontendClient(transport);
		const result = await client.process({ ...baseInput, speakerMode: "off", enhanceAudio: false });
		expect(result.state).toBe("accept");
		expect(result.enhanced).toBe(false);
		expect(result.audio[0]).toBeCloseTo(0.1);
		expect(result.audio[1]).toBeCloseTo(0.2);
	});

	it("returns gate and enhancement metadata", async () => {
		const transport = new FakeTransport(message => {
			const request = message as { type: string; id: string; audio: Float32Array };
			return {
				type: "result",
				id: request.id,
				audio: request.audio,
				state: "uncertain",
				score: 0.5,
				enhanced: true,
				segmentId: 0,
			};
		});
		const client = new VoiceFrontendClient(transport);
		const result = await client.process(baseInput);
		expect(result).toMatchObject({ state: "uncertain", score: 0.5, enhanced: true });
	});

	it("returns speaker embeddings", async () => {
		const transport = new FakeTransport(message => {
			const request = message as { type: string; id: string };
			return { type: "embedding", id: request.id, embedding: new Float32Array([0.6, 0.8]) };
		});
		const client = new VoiceFrontendClient(transport);
		const embedding = await client.embed(baseInput.audio, 16_000);
		expect(embedding[0]).toBeCloseTo(0.6);
		expect(embedding[1]).toBeCloseTo(0.8);
	});

	it("rejects unknown response ids", async () => {
		const transport = new FakeTransport(() => ({
			type: "result",
			id: "other",
			audio: new Float32Array(),
			state: "accept",
			score: null,
			enhanced: false,
			segmentId: 0,
		}));
		const client = new VoiceFrontendClient(transport);
		const error = await client.process(baseInput).then(
			() => null,
			error => error as Error,
		);
		expect(error?.message).toContain("other");
	});

	it("terminates the worker on close", () => {
		const transport = new FakeTransport(() => ({ type: "pong", id: "unused" }));
		const client = new VoiceFrontendClient(transport);
		client.close();
		expect(transport.terminated).toBe(true);
	});
});
