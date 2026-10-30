import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cosineSimilarity } from "../../stt/eval/speaker-verifier";

const MODEL_NAME = "3dspeaker_speech_eres2net_base_200k_sv_zh-cn_16k-common.onnx";
const ACCEPT_THRESHOLD = 0.7;
const REJECT_THRESHOLD = 0.5;
const CONSISTENCY_THRESHOLD = 0.45;
const MIN_TOTAL_SPEECH_MS = 16_000;

export interface SpeakerProfile {
	version: 1;
	model: string;
	dimension: number;
	samples: number[][];
	centroid: number[];
	acceptThreshold: number;
	rejectThreshold: number;
}

export interface EnrollmentState {
	count: number;
	totalMs: number;
}

interface PendingEnrollment extends EnrollmentState {
	vectors: Float32Array[];
}

export class SpeakerProfileStore {
	readonly #profilePath: string;
	readonly #embed: (audio: Float32Array, sampleRate: 16_000) => Promise<Float32Array>;
	#pending: PendingEnrollment = { count: 0, totalMs: 0, vectors: [] };

	constructor(options: {
		profilePath: string;
		embed: (audio: Float32Array, sampleRate: 16_000) => Promise<Float32Array>;
	}) {
		this.#profilePath = options.profilePath;
		this.#embed = options.embed;
	}

	startEnrollment(): EnrollmentState {
		this.#pending = { count: 0, totalMs: 0, vectors: [] };
		return { count: 0, totalMs: 0 };
	}

	async addEnrollmentSample(
		audio: Float32Array,
		sampleRate: 16_000,
	): Promise<{ accepted: boolean; reason?: string; count: number }> {
		if (this.#pending.count >= 4) return { accepted: false, reason: "Enrollment already has four clips", count: 4 };
		const audioMs = (audio.length / sampleRate) * 1000;
		if (audioMs < 2000 || audioMs > 8000) {
			return { accepted: false, reason: "Each clip must be between 2 and 8 seconds", count: this.#pending.count };
		}
		const vector = await this.#embed(audio, sampleRate);
		for (const existing of this.#pending.vectors) {
			if (cosineSimilarity(existing, vector) < CONSISTENCY_THRESHOLD) {
				return {
					accepted: false,
					reason: "Clip does not match the other voice samples",
					count: this.#pending.count,
				};
			}
		}
		this.#pending.vectors.push(vector);
		this.#pending.count++;
		this.#pending.totalMs += audioMs;
		return { accepted: true, count: this.#pending.count };
	}

	async finishEnrollment(
		verificationAudio: Float32Array,
		sampleRate: 16_000,
	): Promise<{ ok: boolean; score?: number; error?: string }> {
		if (this.#pending.count !== 4 || this.#pending.totalMs < MIN_TOTAL_SPEECH_MS) {
			return { ok: false, error: "At least 16 seconds of valid speech is required" };
		}
		if ((verificationAudio.length / sampleRate) * 1000 < 1000)
			return { ok: false, error: "Verification clip is too short" };
		const verification = await this.#embed(verificationAudio, sampleRate);
		const center = centroid(this.#pending.vectors);
		const score = cosineSimilarity(center, verification);
		if (score < ACCEPT_THRESHOLD)
			return { ok: false, score, error: "Verification voice does not match the enrollment" };
		const profile: SpeakerProfile = {
			version: 1,
			model: MODEL_NAME,
			dimension: center.length,
			samples: this.#pending.vectors.map(vector => Array.from(vector)),
			centroid: Array.from(center),
			acceptThreshold: ACCEPT_THRESHOLD,
			rejectThreshold: REJECT_THRESHOLD,
		};
		await fs.mkdir(path.dirname(this.#profilePath), { recursive: true });
		const partial = `${this.#profilePath}.part`;
		await Bun.write(partial, `${JSON.stringify(profile)}\n`);
		await fs.rename(partial, this.#profilePath);
		this.#pending = { count: 0, totalMs: 0, vectors: [] };
		return { ok: true, score };
	}

	cancelEnrollment(): void {
		this.#pending = { count: 0, totalMs: 0, vectors: [] };
	}

	async readSpeakerProfile(): Promise<SpeakerProfile | null> {
		try {
			const profile = JSON.parse(await Bun.file(this.#profilePath).text()) as SpeakerProfile;
			return profile.version === 1 && Array.isArray(profile.samples) ? profile : null;
		} catch {
			return null;
		}
	}

	async deleteSpeakerProfile(): Promise<void> {
		await fs.rm(this.#profilePath, { force: true });
	}
}

function centroid(vectors: Float32Array[]): Float32Array {
	const center = new Float32Array(vectors[0]?.length ?? 0);
	for (const vector of vectors) {
		for (let i = 0; i < center.length; i++) center[i] += vector[i]! / vectors.length;
	}
	return center;
}

export function createSpeakerProfileStore(options: {
	profilePath: string;
	embed: (audio: Float32Array, sampleRate: 16_000) => Promise<Float32Array>;
}): SpeakerProfileStore {
	return new SpeakerProfileStore(options);
}
