import { describe, expect, test } from "bun:test";
import { MAX_SECONDS, MIN_SAMPLES, quantizeSamples, rms, SAMPLE_RATE } from "../electron/global-dictation.cjs";

describe("global dictation audio", () => {
	test("records in the format stt.transcribe expects", () => {
		expect(SAMPLE_RATE).toBe(16_000);
		expect(MIN_SAMPLES).toBe(8_000);
		expect(MAX_SECONDS).toBe(30);
	});

	test("quantises float samples to three decimals for the wire", () => {
		const out = quantizeSamples(new Float32Array([0.123456, -0.98765, 1, 0]));
		expect(out).toEqual([0.123, -0.988, 1, 0]);
	});

	test("rms reports silence, a bounded level and a usable curve", () => {
		expect(rms(new Float32Array(0))).toBe(0);
		expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
		const quiet = rms(new Float32Array([0.05, 0.05]));
		const loud = rms(new Float32Array([0.5, 0.5]));
		expect(quiet).toBeGreaterThan(0);
		expect(loud).toBeGreaterThan(quiet);
		expect(rms(new Float32Array([1, 1]))).toBeLessThanOrEqual(1);
	});
});
