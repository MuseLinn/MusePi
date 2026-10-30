import type { CandidateResult } from "./candidate";
import { type AudioClip, readWavClip } from "./corpus";

export function validateSamples(clip: AudioClip): AudioClip {
	if (clip.samples.length === 0) throw new Error("Candidate audio is empty");
	for (const sample of clip.samples) {
		if (!Number.isFinite(sample)) throw new Error("Candidate audio samples must be finite");
	}
	return clip;
}

export async function validateCandidateAudio(
	result: CandidateResult,
	expected: { sampleRate: number; durationMs: number; maxDurationDeltaMs: number },
): Promise<AudioClip | null> {
	if (result.audioPath === null) return null;
	if (result.sampleRate !== expected.sampleRate) {
		throw new Error(`Candidate sample rate must be ${expected.sampleRate} Hz, received ${result.sampleRate}`);
	}
	const clip = validateSamples(await readWavClip(result.audioPath));
	const durationMs = (clip.samples.length / clip.sampleRate) * 1000;
	if (Math.abs(durationMs - expected.durationMs) > expected.maxDurationDeltaMs) {
		throw new Error(
			`Candidate audio duration mismatch: expected ${expected.durationMs} ms, received ${durationMs} ms`,
		);
	}
	return clip;
}
