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
	it("sends only the delimited run to ASR, and its previews to the preview channel", async () => {
		let utterances = 0;
		let previews = 0;
		const asr: SttStreamHandle = {
			pushAudio: () => {},
			pushUtterance: () => {
				utterances += 1;
			},
			pushPreview: () => {
				previews += 1;
			},
			stop: async () => "hello",
			cancel: () => {},
		};
		const client = new VoiceFrontendClient(new FakeTransport(), () => asr);
		// Gated: the frontend delimits the run itself, so the worker must not
		// see raw frames — it receives the finished run plus volatile previews.
		const stream = start(client, "prefer");
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		stream.pushAudio(new Float32Array(11_200));
		await stream.stop();
		expect(utterances).toBe(1);
		expect(previews).toBeGreaterThan(0);
		client.close();
	});

	it("hands raw frames to the worker when nothing gates the audio", async () => {
		let frames = 0;
		let utterances = 0;
		const client = new VoiceFrontendClient(new FakeTransport(), () => ({
			pushAudio: () => {
				frames += 1;
			},
			pushUtterance: () => {
				utterances += 1;
			},
			pushPreview: () => {},
			stop: async () => "",
			cancel: () => {},
		}));
		const stream = start(client, "off");
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		await stream.stop();
		// A second endpointer here would re-segment audio the worker owns and hold
		// every commit until `stream_stop` — the "text only appears at the end" bug.
		expect(frames).toBe(1);
		expect(utterances).toBe(0);
		client.close();
	});

	it("emits the worker's own segments as frontend results when ungated", async () => {
		const segments: string[] = [];
		const client = new VoiceFrontendClient(new FakeTransport(), (_key, options) => ({
			pushAudio: () => {},
			pushUtterance: () => {},
			pushPreview: () => {},
			stop: async () => {
				options?.onSegment?.("first", 0);
				options?.onSegment?.("second", 1);
				return "first second";
			},
			cancel: () => {},
		}));
		const stream = start(client, "off", { onSegment: text => segments.push(text) });
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		const { results, text } = await stream.stop();
		expect(segments).toEqual(["first", "second"]);
		expect(text).toBe("first second");
		expect(results.map(result => result.text)).toEqual(["first", "second"]);
		client.close();
	});

	it("keeps finalized ASR text attached to its own frontend segment", async () => {
		let callbacks: SttStreamOptions | undefined;
		const client = new VoiceFrontendClient(new FakeTransport(), (_key, options) => {
			callbacks = options;
			return {
				pushAudio: () => {},
				pushUtterance: () => {},
				pushPreview: () => {},
				stop: async () => {
					callbacks?.onSegment?.("first", 0);
					callbacks?.onSegment?.("second", 1);
					return "first second";
				},
				cancel: () => {},
			};
		});
		const stream = start(client, "prefer");
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		stream.pushAudio(new Float32Array(11_200));
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		const { results } = await stream.stop();
		expect(results.map(result => result.text)).toEqual(["first", "second"]);
		client.close();
	});

	it("does not send rejected strict-mode audio to ASR", async () => {
		let pushes = 0;
		const transport = new FakeTransport();
		transport.state = "reject";
		const client = new VoiceFrontendClient(transport, () => ({
			pushAudio: () => {},
			pushUtterance: () => {
				pushes += 1;
			},
			pushPreview: () => {},
			stop: async () => "",
			cancel: () => {},
		}));
		const stream = start(client, "strict");
		stream.pushAudio(new Float32Array(16_000).fill(0.1));
		const { results } = await stream.stop();
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
			return {
				pushAudio: () => {},
				pushUtterance: () => {},
				pushPreview: () => {},
				stop: async () => "late",
				cancel: () => {},
			};
		});
		const stream = start(client, "prefer", {
			onPartial: text => partials.push(text),
			onSegment: text => segments.push(text),
		});
		stream.cancel();
		callbacks?.onPartial?.("late");
		callbacks?.onSegment?.("late", 0);
		expect(await stream.stop()).toEqual({ results: [], text: "" });
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
			pushUtterance: () => {},
			pushPreview: () => {},
			stop: async () => "",
			cancel: () => {},
		}));
		const stream = start(client, "prefer");
		for (let index = 0; index < 5; index++) {
			stream.pushAudio(new Float32Array(16_000).fill(0.1));
			stream.pushAudio(new Float32Array(11_200));
		}
		await expect(stream.stop()).rejects.toThrow("busy");
		client.close();
	});
});
