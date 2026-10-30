import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@musepi/pi-utils";
import type { SherpaRuntime, SherpaSpeakerEmbeddingExtractor } from "../sherpa-runtime";
import type { AudioClip } from "./corpus";

const SPEAKER_MODEL_FILE = "3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx";
const SPEAKER_MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${SPEAKER_MODEL_FILE}`;

export interface SpeakerVerifier {
	embed(clip: AudioClip): Promise<Float32Array>;
	close(): Promise<void>;
}

class SherpaSpeakerVerifier implements SpeakerVerifier {
	#extractor: SherpaSpeakerEmbeddingExtractor | null = null;

	constructor(
		readonly runtime: SherpaRuntime,
		readonly modelPath: string,
		readonly numThreads: number,
	) {}

	async embed(clip: AudioClip): Promise<Float32Array> {
		this.#extractor ??= new this.runtime.SpeakerEmbeddingExtractor({
			model: this.modelPath,
			numThreads: this.numThreads,
			debug: 0,
			provider: "cpu",
		});
		const stream = this.#extractor.createStream();
		stream.acceptWaveform({ samples: clip.samples, sampleRate: clip.sampleRate });
		stream.inputFinished();
		for (let i = 0; i < 1000 && !this.#extractor.isReady(stream); i++) {}
		if (!this.#extractor.isReady(stream)) throw new Error("Speaker embedding extractor did not become ready");
		return normalizeEmbedding(this.#extractor.compute(stream));
	}

	async close(): Promise<void> {
		this.#extractor = null;
	}
}

export function createSherpaSpeakerVerifier(options: {
	runtime: SherpaRuntime;
	modelPath: string;
	numThreads: number;
}): SpeakerVerifier {
	return new SherpaSpeakerVerifier(options.runtime, options.modelPath, options.numThreads);
}

function normalizeEmbedding(embedding: Float32Array): Float32Array {
	let sum = 0;
	for (const value of embedding) sum += value * value;
	const norm = Math.sqrt(sum);
	if (!(norm > 0)) throw new Error("Speaker embedding has zero norm");
	return embedding.map(value => value / norm);
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
	if (left.length !== right.length) throw new Error("Speaker embedding dimensions differ");
	const a = normalizeEmbedding(left);
	const b = normalizeEmbedding(right);
	let score = 0;
	for (let i = 0; i < a.length; i++) score += a[i]! * b[i]!;
	return score;
}

export async function ensureSpeakerEmbeddingModel(): Promise<string> {
	const destination = path.join(getTinyModelsCacheDir(), "speaker-verification", SPEAKER_MODEL_FILE);
	try {
		const stat = await fs.stat(destination);
		if (stat.size > 0) return destination;
	} catch {}
	const response = await fetch(SPEAKER_MODEL_URL);
	if (!response.ok) throw new Error(`Failed to download speaker embedding model: HTTP ${response.status}`);
	const partial = `${destination}.part`;
	await Bun.write(partial, await response.arrayBuffer());
	await fs.rename(partial, destination);
	return destination;
}
