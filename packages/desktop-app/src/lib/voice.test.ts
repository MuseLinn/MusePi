import { describe, expect, test } from "bun:test";
import { evaluateSubmitTrigger, quantiseForWire, resampleToTargetRate, TARGET_SAMPLE_RATE } from "./voice";

describe("resampleToTargetRate (#23 B)", () => {
	test("is a no-op at the target rate", () => {
		const pcm = new Float32Array([0, 0.25, 0.5, 1]);
		expect(resampleToTargetRate(pcm, TARGET_SAMPLE_RATE)).toBe(pcm);
	});

	test("is a no-op for an empty buffer", () => {
		expect(resampleToTargetRate(new Float32Array(0), 48_000).length).toBe(0);
	});

	test("downsamples 48 kHz → 16 kHz at a 3:1 length ratio", () => {
		// 4800 samples at 48 kHz = 100 ms of audio → 1600 samples at 16 kHz.
		const pcm = new Float32Array(4800);
		for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((i / pcm.length) * Math.PI * 2);
		const out = resampleToTargetRate(pcm, 48_000);
		expect(out.length).toBe(1600);
	});

	test("interpolates instead of point-aliasing (fractional phase)", () => {
		// 24 kHz → 16 kHz is a 1.5× ratio, so output sample 1 lands exactly on
		// the midpoint of input[1] and input[2].
		const out = resampleToTargetRate(Float32Array.of(0, 1, 0, 0), 24_000);
		expect(out.length).toBe(2);
		expect(out[0]).toBe(0);
		expect(out[1]).toBeCloseTo(0.5, 6);
	});

	test("preserves the peak amplitude of a constant signal", () => {
		const pcm = new Float32Array(48_000).fill(0.5);
		const out = resampleToTargetRate(pcm, 48_000);
		expect(out.every(v => Math.abs(v - 0.5) < 1e-6)).toBeTrue();
	});
});

describe("quantiseForWire (#23 C)", () => {
	test("stays inside the daemon's 4 MiB request cap for a full 15 s buffer", () => {
		// 15 s at 16 kHz mono, worst-case amplitudes everywhere. The daemon
		// rejects requests over MAX_REQUEST_BYTES = 4 * 1024 * 1024, and this
		// exact payload is what stt.transcribe receives.
		const pcm = new Float32Array(TARGET_SAMPLE_RATE * 15);
		for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * 0.01) * (i % 2 ? 1 : -1);
		const payload = JSON.stringify({ audio: quantiseForWire(pcm) });
		expect(payload.length).toBeLessThan(4 * 1024 * 1024);
	});

	test("loses at most 1e-5 of amplitude (inaudible for 16-bit ASR audio)", () => {
		const pcm = new Float32Array([0.123456789, -0.987654321, 1e-9, -1, 1]);
		const out = quantiseForWire(pcm);
		for (let i = 0; i < pcm.length; i++) expect(Math.abs(out[i]! - pcm[i]!)).toBeLessThanOrEqual(1e-5);
	});

	test("returns plain numbers, not Float32Array (JSON-friendly)", () => {
		expect(Array.isArray(quantiseForWire(new Float32Array([0.5])))).toBeTrue();
	});
});

// Guard the existing submit-trigger copy stays intact while voice.ts changes.
describe("evaluateSubmitTrigger (unchanged contract)", () => {
	test("release requires two words", () => {
		expect(evaluateSubmitTrigger("hello", "release").submit).toBeFalse();
		expect(evaluateSubmitTrigger("hello world", "release").submit).toBeTrue();
	});
	test("never never submits", () => {
		expect(evaluateSubmitTrigger("hello world", "never").submit).toBeFalse();
	});
});
