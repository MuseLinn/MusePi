import { afterEach, describe, expect, it } from "bun:test";
import {
	type NativeRecognitionOptions,
	nativeVoiceSupport,
	speakNative,
	startNativeRecognition,
} from "../src/lib/native-voice";

/** Minimal fake SpeechRecognition whose events the test drives by hand. */
class FakeRecognition {
	lang = "";
	continuous = false;
	interimResults = false;
	onresult:
		| ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void)
		| null = null;
	onerror: ((e: { error?: string }) => void) | null = null;
	onend: (() => void) | null = null;
	started = 0;
	aborted = false;
	stopped = false;
	start(): void {
		this.started++;
	}
	stop(): void {
		this.stopped = true;
	}
	abort(): void {
		this.aborted = true;
	}
}

let lastFake: FakeRecognition | null = null;
class SeededFakeCtor extends FakeRecognition {
	constructor() {
		super();
		lastFake = this;
	}
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).window;
	lastFake = null;
});

function harness(opts: Partial<NativeRecognitionOptions> = {}): {
	finals: string[];
	errors: string[];
} {
	const finals: string[] = [];
	const errors: string[] = [];
	startNativeRecognition({
		onFinal: t => finals.push(t),
		onError: e => errors.push(e),
		...opts,
	});
	return { finals, errors };
}

describe("nativeVoiceSupport", () => {
	it("reports both halves missing without a window (SSR/test env)", () => {
		expect(nativeVoiceSupport()).toEqual({ recognition: false, synthesis: false });
	});

	it("detects the prefixed iOS constructor without speechSynthesis", () => {
		(globalThis as Record<string, unknown>).window = { webkitSpeechRecognition: SeededFakeCtor };
		expect(nativeVoiceSupport()).toEqual({ recognition: true, synthesis: false });
	});
});

describe("startNativeRecognition", () => {
	it("returns null when the constructor is unavailable", () => {
		(globalThis as Record<string, unknown>).window = {};
		expect(startNativeRecognition({ onFinal: () => {}, onError: () => {} })).toBeNull();
	});

	it("delivers the final transcript through onresult + onend", () => {
		(globalThis as Record<string, unknown>).window = { SpeechRecognition: SeededFakeCtor };
		const { finals, errors } = harness();
		const rec = lastFake;
		expect(rec).not.toBeNull();
		rec!.onresult!({
			resultIndex: 0,
			results: [{ isFinal: true, 0: { transcript: "你好世界" } }],
		});
		rec!.onend!();
		expect(finals).toEqual(["你好世界"]);
		expect(errors).toEqual([]);
	});

	it("reports no-speech when onend lands without a transcript", () => {
		(globalThis as Record<string, unknown>).window = { SpeechRecognition: SeededFakeCtor };
		const { finals, errors } = harness();
		lastFake!.onend!();
		expect(finals).toEqual([]);
		expect(errors).toEqual(["no speech detected"]);
	});

	it("stop() finishes asynchronously: the transcript still arrives via onend", () => {
		(globalThis as Record<string, unknown>).window = { SpeechRecognition: SeededFakeCtor };
		const finals: string[] = [];
		const handle = startNativeRecognition({ onFinal: t => finals.push(t), onError: () => {} });
		const rec = lastFake!;
		handle!.stop();
		expect(rec.stopped).toBe(true);
		// The late final result lands after the manual stop — onend delivers it.
		rec.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "late" } }] });
		rec.onend!();
		expect(finals).toContain("late");
	});

	it("abort() silences every callback (composer cancel path)", () => {
		(globalThis as Record<string, unknown>).window = { SpeechRecognition: SeededFakeCtor };
		const finals: string[] = [];
		const errors: string[] = [];
		const handle = startNativeRecognition({
			onFinal: t => finals.push(t),
			onError: e => errors.push(e),
		});
		const rec = lastFake!;
		handle!.abort();
		expect(rec.aborted).toBe(true);
		rec.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "dropped" } }] });
		rec.onend!();
		expect(finals).toEqual([]);
		expect(errors).toEqual([]);
	});

	it("maps engine error codes to readable one-liners", () => {
		(globalThis as Record<string, unknown>).window = { SpeechRecognition: SeededFakeCtor };
		const { errors } = harness();
		lastFake!.onerror!({ error: "not-allowed" });
		expect(errors).toEqual(["microphone permission denied"]);
	});
});

describe("speakNative", () => {
	it("reports unavailable without a window instead of throwing", () => {
		const errors: string[] = [];
		const stop = speakNative("hi", {}, { onError: e => errors.push(e) });
		expect(errors).toEqual(["speech synthesis unavailable"]);
		expect(stop()).toBeUndefined();
	});
});
