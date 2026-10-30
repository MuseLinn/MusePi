import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCorpusManifest, readWavClip } from "@musepi/pi-coding-agent/stt/eval/corpus";
import { levenshteinRate, mixClips, percentile } from "@musepi/pi-coding-agent/stt/eval/metrics";
import { encodeWav } from "@musepi/pi-coding-agent/tts/wav";
import { removeWithRetries } from "@musepi/pi-utils";

let tmp = "";

afterEach(async () => {
	if (tmp) await removeWithRetries(tmp);
	tmp = "";
});

async function fixtureDir(): Promise<string> {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-speech-eval-"));
	return tmp;
}

async function writeManifest(dir: string, rows: Array<Record<string, unknown>>): Promise<string> {
	const manifestPath = path.join(dir, "corpus.jsonl");
	await Bun.write(manifestPath, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
	return manifestPath;
}

function validRow(id = "clean-1"): Record<string, unknown> {
	return {
		id,
		kind: "clean",
		mixturePath: "mixture.wav",
		enrollmentPaths: ["enrollment.wav"],
		transcript: "打开文件",
		targetMs: 1600,
	};
}

describe("speech evaluation corpus", () => {
	it("loads valid items and resolves audio paths relative to the manifest", async () => {
		const dir = await fixtureDir();
		const pcm = new Float32Array([0, 0.25, -0.25]);
		await Bun.write(path.join(dir, "mixture.wav"), encodeWav(pcm, 16_000));
		await Bun.write(path.join(dir, "enrollment.wav"), encodeWav(pcm, 16_000));
		const manifestPath = await writeManifest(dir, [validRow()]);

		const items = await loadCorpusManifest(manifestPath);

		expect(items).toHaveLength(1);
		expect(items[0]).toEqual({
			id: "clean-1",
			kind: "clean",
			mixturePath: path.join(dir, "mixture.wav"),
			enrollmentPaths: [path.join(dir, "enrollment.wav")],
			transcript: "打开文件",
			targetMs: 1600,
		});
	});

	it("reads mono PCM16 WAV into normalized float samples", async () => {
		const dir = await fixtureDir();
		const wavPath = path.join(dir, "clip.wav");
		await Bun.write(wavPath, encodeWav(new Float32Array([0, 0.5, -0.5]), 16_000));

		const clip = await readWavClip(wavPath);

		expect(clip.sampleRate).toBe(16_000);
		expect(clip.samples[0]).toBe(0);
		expect(clip.samples[1]).toBeCloseTo(0.5);
		expect(clip.samples[2]).toBeCloseTo(-0.5);
	});

	it("rejects duplicate item ids", async () => {
		const dir = await fixtureDir();
		const manifestPath = await writeManifest(dir, [validRow(), validRow()]);
		await expect(loadCorpusManifest(manifestPath)).rejects.toThrow("duplicate");
	});

	it("rejects unknown corpus kinds", async () => {
		const dir = await fixtureDir();
		const manifestPath = await writeManifest(dir, [{ ...validRow(), kind: "music" }]);
		await expect(loadCorpusManifest(manifestPath)).rejects.toThrow("kind");
	});

	it("rejects missing audio files", async () => {
		const dir = await fixtureDir();
		const manifestPath = await writeManifest(dir, [validRow()]);
		await expect(loadCorpusManifest(manifestPath)).rejects.toThrow("mixture.wav");
	});

	it("rejects audio that is not 16 kHz", async () => {
		const dir = await fixtureDir();
		const pcm = new Float32Array([0, 0.25]);
		await Bun.write(path.join(dir, "mixture.wav"), encodeWav(pcm, 8_000));
		await Bun.write(path.join(dir, "enrollment.wav"), encodeWav(pcm, 16_000));
		const manifestPath = await writeManifest(dir, [validRow()]);
		await expect(loadCorpusManifest(manifestPath)).rejects.toThrow("16000");
	});

	it("requires interferer-only items to contain no target speech", async () => {
		const dir = await fixtureDir();
		const manifestPath = await writeManifest(dir, [{ ...validRow("other-1"), kind: "interferer" }]);
		await expect(loadCorpusManifest(manifestPath)).rejects.toThrow("targetMs");
	});
});

describe("speech evaluation metrics", () => {
	it("computes character error rate for Chinese text", () => {
		expect(levenshteinRate("打开文件", "打开文档", "char")).toBe(0.25);
	});

	it("computes word error rate for English text", () => {
		expect(levenshteinRate("hello world", "hello brave world", "word")).toBe(0.5);
	});

	it("rejects an empty reference", () => {
		expect(() => levenshteinRate("", "anything", "word")).toThrow("empty");
	});

	it("computes percentiles from unsorted values", () => {
		expect(percentile([100, 0, 50, 25, 75], 0.5)).toBe(50);
		expect(percentile([100, 0, 50, 25, 75], 0.95)).toBe(100);
	});

	it("mixes clips with gains and pads the shorter clip", () => {
		const mixed = mixClips(
			{ samples: new Float32Array([0.2, -0.4, 0.1]), sampleRate: 16_000 },
			{ samples: new Float32Array([0.1, 0.2]), sampleRate: 16_000 },
			0.5,
			2,
		);
		expect(mixed.samples[0]).toBeCloseTo(0.3);
		expect(mixed.samples[1]).toBeCloseTo(0.2);
		expect(mixed.samples[2]).toBeCloseTo(0.05);
	});

	it("clamps mixed float samples instead of wrapping integer PCM", () => {
		const mixed = mixClips(
			{ samples: new Float32Array([0.8, 0.8]), sampleRate: 16_000 },
			{ samples: new Float32Array([0.8, -0.8]), sampleRate: 16_000 },
			1,
			1,
		);
		expect(Array.from(mixed.samples)).toEqual([1, 0]);
	});
});
