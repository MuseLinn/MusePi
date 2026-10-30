import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateCandidateAudio, validateSamples } from "@musepi/pi-coding-agent/stt/eval/audio-validation";
import type { CandidateResult } from "@musepi/pi-coding-agent/stt/eval/candidate";
import { encodeWav } from "@musepi/pi-coding-agent/tts/wav";
import { removeWithRetries } from "@musepi/pi-utils";

let tmp = "";

afterEach(async () => {
	if (tmp) await removeWithRetries(tmp);
	tmp = "";
});

async function resultWithWav(samples: Float32Array, sampleRate = 16_000): Promise<CandidateResult> {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-candidate-audio-"));
	const audioPath = path.join(tmp, "candidate.wav");
	await Bun.write(audioPath, encodeWav(samples, sampleRate));
	return { id: "item", audioPath, sampleRate, loadMs: 0, inferenceMs: 1, rssBytes: 100 };
}

const expected = { sampleRate: 16_000, durationMs: 100, maxDurationDeltaMs: 100 };

describe("candidate audio validation", () => {
	it("returns a valid 16 kHz clip", async () => {
		const result = await resultWithWav(new Float32Array(1600).fill(0.25));
		const clip = await validateCandidateAudio(result, expected);
		expect(clip?.sampleRate).toBe(16_000);
		expect(clip?.samples).toHaveLength(1600);
		expect(clip?.samples[0]).toBeCloseTo(0.25);
	});

	it("allows an explicit null-audio rejection", async () => {
		const result: CandidateResult = {
			id: "other",
			audioPath: null,
			sampleRate: 16_000,
			loadMs: 0,
			inferenceMs: 1,
			rssBytes: 100,
		};
		expect(await validateCandidateAudio(result, expected)).toBeNull();
	});

	it("rejects empty candidate output", async () => {
		const result = await resultWithWav(new Float32Array());
		const error = await validateCandidateAudio(result, expected).then(
			() => null,
			error => error as Error,
		);
		expect(error?.message).toContain("empty");
	});

	it("rejects the wrong sample rate", async () => {
		const result = await resultWithWav(new Float32Array(800), 8_000);
		const error = await validateCandidateAudio(result, { ...expected, durationMs: 100 }).then(
			() => null,
			error => error as Error,
		);
		expect(error?.message).toContain("16000");
	});

	it("rejects duration drift beyond the allowed bound", async () => {
		const result = await resultWithWav(new Float32Array(1600));
		const error = await validateCandidateAudio(result, { ...expected, durationMs: 250 }).then(
			() => null,
			error => error as Error,
		);
		expect(error?.message).toContain("duration");
	});

	it("rejects non-finite samples", () => {
		expect(() => validateSamples({ samples: new Float32Array([0, Number.NaN, 0.5]), sampleRate: 16_000 })).toThrow(
			"finite",
		);
	});
});
