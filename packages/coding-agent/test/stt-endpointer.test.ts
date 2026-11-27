import { describe, expect, it } from "bun:test";
import { StreamEndpointer } from "../src/stt/endpointer";
import { type DetectedSpeech, type SpeechDetector, SpeechEndpointer } from "../src/stt/speech-endpointer";

function frames(count: number, sampleRate: number, frameMs: number, value: number): Float32Array[] {
	return Array.from({ length: count }, () => new Float32Array((sampleRate * frameMs) / 1000).fill(value));
}

class ScriptedDetector implements SpeechDetector {
	readonly queued: DetectedSpeech[] = [];
	detected = false;
	onAccept: ((samples: Float32Array) => void) | null = null;
	onFlush: (() => void) | null = null;

	acceptWaveform(samples: Float32Array): void {
		this.onAccept?.(samples);
	}
	isEmpty(): boolean {
		return this.queued.length === 0;
	}
	isDetected(): boolean {
		return this.detected;
	}
	front(): DetectedSpeech {
		return this.queued[0]!;
	}
	pop(): void {
		this.queued.shift();
	}
	flush(): void {
		this.onFlush?.();
	}
}

describe("stream endpoint ranges", () => {
	it("keeps a short pause inside the sentence and emits only a preview", () => {
		const endpointer = new StreamEndpointer({
			sampleRate: 1_000,
			frameMs: 20,
			endSilenceMs: 700,
			maxSegmentMs: 30_000,
			preRollMs: 250,
			phraseSilenceMs: 160,
			minPhraseMs: 1_000,
		});
		let now = 1_000;
		const push = (frame: Float32Array) => {
			now += 100;
			return endpointer.push(frame, now);
		};
		for (const frame of frames(60, 1_000, 20, 0.1)) push(frame);
		const previews = frames(10, 1_000, 20, 0).flatMap(push);
		expect(previews.some(event => event.kind === "partial")).toBe(true);
		expect(previews.some(event => event.kind === "segment")).toBe(false);
		for (const frame of frames(60, 1_000, 20, 0.1)) push(frame);
		const finals = frames(35, 1_000, 20, 0).flatMap(push);
		const segment = finals.find(event => event.kind === "segment");
		expect(segment?.start).toBe(0);
		expect(segment?.end).toBeGreaterThan(2_500);
		expect(segment?.end).toBeLessThan(3_100);
	});

	it("force-splits continuous speech at the configured sentence ceiling", () => {
		const endpointer = new StreamEndpointer({
			sampleRate: 1_000,
			frameMs: 20,
			maxSegmentMs: 3_000,
			endSilenceMs: 700,
		});
		const events = frames(150, 1_000, 20, 0.1).flatMap((frame, index) => endpointer.push(frame, index * 20));
		const segment = events.find(event => event.kind === "segment");
		expect(segment?.start).toBe(0);
		expect(segment?.end).toBe(3_000);
		const trailing = endpointer.flush().find(event => event.kind === "segment");
		expect(trailing).toBeUndefined();
	});

	it("starts the preview interval when inference finishes", () => {
		const endpointer = new StreamEndpointer({ sampleRate: 1_000, frameMs: 20, partialIntervalMs: 450 });
		const frame = new Float32Array(20).fill(0.1);
		endpointer.push(frame, 1_000);
		expect(endpointer.push(frame, 1_100).some(event => event.kind === "partial")).toBe(true);
		endpointer.notePartialDecode(600, 2_000);
		expect(endpointer.push(frame, 2_200).some(event => event.kind === "partial")).toBe(false);
		expect(endpointer.push(frame, 2_500).some(event => event.kind === "partial")).toBe(true);
	});

	it("assigns the remainder of an endpoint-carrying chunk to the next sentence", () => {
		const detector = new ScriptedDetector();
		const audio = new Float32Array(4_700);
		audio.fill(0.1, 0, 2_000);
		audio.fill(0.1, 2_700);
		detector.onAccept = () => {
			detector.queued.push({ start: 0, samples: audio.slice(0, 2_000) });
			detector.detected = true;
		};
		detector.onFlush = () => {
			detector.queued.push({ start: 2_700, samples: audio.slice(2_700) });
			detector.detected = false;
		};
		const endpointer = new SpeechEndpointer(detector, {
			sampleRate: 1_000,
			preRollMs: 250,
			tailMs: 120,
		});
		const first = endpointer.push(audio).find(event => event.kind === "segment");
		const second = endpointer.flush().find(event => event.kind === "segment");
		expect(first?.start).toBe(0);
		expect(first?.end).toBe(2_120);
		expect(second?.start).toBe(2_450);
		expect(second?.end).toBe(4_700);
		expect(second!.start).toBeGreaterThanOrEqual(first!.end);
		expect(Array.from(first!.audio)).toEqual(Array.from(audio.slice(first!.start, first!.end)));
		expect(Array.from(second!.audio)).toEqual(Array.from(audio.slice(second!.start, second!.end)));
	});
});
