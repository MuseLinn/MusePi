import { describe, expect, it } from "bun:test";
import type { SttWorkerOutbound } from "../src/stt/asr-protocol";
import type { LiveEndpointer } from "../src/stt/endpointer";
import { LiveStreamingSession } from "../src/stt/streaming-session";

interface DecodeCall {
	audio: Float32Array;
	kind: "partial" | "segment";
}

function harness(endpointer: LiveEndpointer, decoded: (call: DecodeCall) => string) {
	const calls: DecodeCall[] = [];
	const messages: SttWorkerOutbound[] = [];
	const session = new LiveStreamingSession({
		id: "test",
		sampleRate: 1_000,
		minDecodeMs: 1_000,
		createEndpointer: async () => endpointer,
		decode: async (audio, kind) => {
			const call = { audio, kind };
			calls.push(call);
			return decoded(call);
		},
		send: message => messages.push(message),
	});
	return { session, calls, messages };
}

function rangedEndpointer(onFlush: LiveEndpointer["flush"] = () => []): LiveEndpointer {
	let offset = 0;
	return {
		partialsEnabled: true,
		push(samples) {
			const start = offset;
			offset += samples.length;
			return [{ kind: "segment", start, end: offset, audio: new Float32Array([0.75]) }];
		},
		flush: onFlush,
		notePartialDecode() {},
	};
}

describe("live streaming session", () => {
	it("decodes finals from retained raw audio rather than detector-owned fragments", async () => {
		const { session, calls, messages } = harness(rangedEndpointer(), () => "recognized");
		const original = new Float32Array([0.25, -0.5, 0.75, -1]);
		session.pushAudio(original);
		await session.stop();
		const final = calls.find(call => call.kind === "segment")!;
		expect(final.audio.length).toBe(1_000);
		expect(Array.from(final.audio.slice(0, 4))).toEqual(Array.from(original));
		expect(final.audio.slice(4).every(sample => sample === 0)).toBe(true);
		expect(messages.filter(message => message.type === "stream_done")).toHaveLength(1);
	});

	it("decodes only the trailing sentence on stop and then joins finalized sentences", async () => {
		let offset = 0;
		const endpointer: LiveEndpointer = {
			partialsEnabled: true,
			push(samples) {
				const start = offset;
				offset += samples.length;
				return offset === 1_000 ? [{ kind: "segment", start, end: offset, audio: samples }] : [];
			},
			flush() {
				return [{ kind: "segment", start: 1_000, end: offset, audio: new Float32Array() }];
			},
			notePartialDecode() {},
		};
		const { session, calls, messages } = harness(endpointer, call => (call.audio[0] === 0.25 ? "第一句" : "第二句"));
		session.pushAudio(new Float32Array(1_000).fill(0.25));
		session.pushAudio(new Float32Array(800).fill(0.5));
		await session.stop();
		expect(calls.filter(call => call.kind === "segment")).toHaveLength(2);
		expect(messages.filter(message => message.type === "segment").map(message => message.text)).toEqual([
			"第一句",
			"第二句",
		]);
		expect(messages.find(message => message.type === "stream_done")?.text).toBe("第一句第二句");
	});

	it("removes sentence-final punctuation from volatile previews", async () => {
		const endpointer: LiveEndpointer = {
			partialsEnabled: true,
			push(samples) {
				return [{ kind: "partial", start: 0, end: samples.length, audio: samples }];
			},
			flush: () => [],
			notePartialDecode() {},
		};
		const { session, messages } = harness(endpointer, () => "还没有说完。");
		session.pushAudio(new Float32Array(1_000).fill(0.1));
		await session.stop();
		expect(messages.find(message => message.type === "partial")?.text).toBe("还没有说完");
	});

	it("clears a preview when the final decode is a known caption hallucination", async () => {
		const { session, messages } = harness(rangedEndpointer(), () => "Subtitles by Amara.org.");
		session.pushAudio(new Float32Array(1_000).fill(0.25));
		await session.stop();
		expect(messages.find(message => message.type === "segment")?.text).toBe("");
		expect(messages.find(message => message.type === "stream_done")?.text).toBe("");
	});
});
