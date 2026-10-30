import { describe, expect, it } from "bun:test";
import type { SttStreamHandle, SttStreamOptions } from "../src/stt/asr-client";
import { VoiceFrontendClient } from "../src/voice/frontend/client";
import type { GateState, SpeakerMode } from "../src/voice/frontend/gate";
import type {
	VoiceFrontendTransport,
	VoiceFrontendWorkerInbound,
	VoiceFrontendWorkerOutbound,
} from "../src/voice/frontend/protocol";

class FakeTransport implements VoiceFrontendTransport {
	state: GateState = "accept";
	#handler: ((message: VoiceFrontendWorkerOutbound) => void) | null = null;
	send(message: VoiceFrontendWorkerInbound): void {
		if (message.type === "embed") {
			this.#handler?.({ type: "embedding", id: message.id, embedding: new Float32Array([1, 0]) });
			return;
		}
		if (message.type === "ping") {
			this.#handler?.({ type: "pong", id: message.id });
			return;
		}
		this.#handler?.({
			type: "result",
			id: message.id,
			audio: message.audio,
			state: this.state,
			score: null,
			enhanced: false,
			segmentId: 0,
		});
	}
	onMessage(handler: (message: VoiceFrontendWorkerOutbound) => void): () => void {
		this.#handler = handler;
		return () => {};
	}
	terminate(): void {}
}

function start(client: VoiceFrontendClient, speakerMode: SpeakerMode = "off", events: Partial<SttStreamOptions> = {}) {
	return client.startStream({
		modelKey: "balanced",
		speakerMode,
		enhanceAudio: false,
		enrollment: [],
		acceptThreshold: 0.7,
		rejectThreshold: 0.5,
		onPartial: result => events.onPartial?.(result.text),
		onSegment: result => events.onSegment?.(result.text, result.segmentId),
	});
}

describe("voice frontend streaming", () => {
	it("feeds only finalized audio to ASR instead of duplicating partial buffers", async () => {
		let pushes = 0;
		const asr: SttStreamHandle = {
			pushAudio: () => {
				pushes += 1;
			},
			stop: async () => "hello",
			cancel: () => {},
		};
		const client = new VoiceFrontendClient(new FakeTransport(), () => asr);
		const stream = start(client);
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		await stream.stop();
		expect(pushes).toBe(1);
		client.close();
	});

	it("keeps finalized ASR text attached to its own frontend segment", async () => {
		let callbacks: SttStreamOptions | undefined;
		const client = new VoiceFrontendClient(new FakeTransport(), (_key, options) => {
			callbacks = options;
			return {
				pushAudio: () => {},
				stop: async () => {
					callbacks?.onSegment?.("first", 0);
					callbacks?.onSegment?.("second", 1);
					return "first second";
				},
				cancel: () => {},
			};
		});
		const stream = start(client);
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		stream.pushAudio(new Float32Array(11_200));
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		const results = await stream.stop();
		expect(results.map(result => result.text)).toEqual(["first", "second"]);
		client.close();
	});

	it("does not send rejected strict-mode audio to ASR", async () => {
		let pushes = 0;
		const transport = new FakeTransport();
		transport.state = "reject";
		const client = new VoiceFrontendClient(transport, () => ({
			pushAudio: () => {
				pushes += 1;
			},
			stop: async () => "",
			cancel: () => {},
		}));
		const stream = start(client, "strict");
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		const results = await stream.stop();
		expect(pushes).toBe(0);
		expect(results.map(result => result.state)).toEqual(["reject"]);
		client.close();
	});

	it("invalidates late ASR callbacks after cancellation", async () => {
		let callbacks: SttStreamOptions | undefined;
		const partials: string[] = [];
		const segments: string[] = [];
		const client = new VoiceFrontendClient(new FakeTransport(), (_key, options) => {
			callbacks = options;
			return { pushAudio: () => {}, stop: async () => "late", cancel: () => {} };
		});
		const stream = start(client, "prefer", {
			onPartial: text => partials.push(text),
			onSegment: text => segments.push(text),
		});
		stream.cancel();
		callbacks?.onPartial?.("late");
		callbacks?.onSegment?.("late", 0);
		expect(await stream.stop()).toEqual([]);
		expect(partials).toEqual([]);
		expect(segments).toEqual([]);
		client.close();
	});

	it("fails explicitly instead of growing an unbounded inference queue", async () => {
		const transport: VoiceFrontendTransport = {
			send: () => {},
			onMessage: () => () => {},
			terminate: () => {},
		};
		const client = new VoiceFrontendClient(transport, () => ({
			pushAudio: () => {},
			stop: async () => "",
			cancel: () => {},
		}));
		const stream = start(client);
		for (let index = 0; index < 5; index++) {
			stream.pushAudio(new Float32Array(16_000).fill(0.1));
			stream.pushAudio(new Float32Array(11_200));
		}
		await expect(stream.stop()).rejects.toThrow("busy");
		client.close();
	});
});
