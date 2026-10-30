export type SpeakerMode = "off" | "prefer" | "strict";
export type GateState = "accept" | "uncertain" | "reject";

export interface GateDecision {
	state: GateState;
	score: number | null;
	autoSubmit: boolean;
}

export function decideSpeakerGate(input: {
	targetMs: number;
	score: number | null;
	acceptThreshold: number;
	rejectThreshold: number;
}): GateDecision {
	if (input.targetMs === 0) return { state: "reject", score: null, autoSubmit: false };
	if (input.targetMs < 1000 || input.score === null) {
		return { state: "uncertain", score: input.score, autoSubmit: false };
	}
	if (input.score < input.rejectThreshold) return { state: "reject", score: input.score, autoSubmit: false };
	if (input.score >= input.acceptThreshold) return { state: "accept", score: input.score, autoSubmit: true };
	return { state: "uncertain", score: input.score, autoSubmit: false };
}

export function shouldEnhanceAudio(audio: Float32Array): boolean {
	if (audio.length === 0) return false;
	const energies: number[] = [];
	for (let offset = 0; offset < audio.length; offset += 320) {
		let sum = 0;
		const end = Math.min(offset + 320, audio.length);
		for (let index = offset; index < end; index++) sum += audio[index]! * audio[index]!;
		energies.push(sum / (end - offset));
	}
	energies.sort((a, b) => a - b);
	const percentile = (ratio: number): number =>
		energies[Math.min(energies.length - 1, Math.floor(energies.length * ratio))]!;
	const noiseFloor = Math.sqrt(Math.max(1e-12, percentile(0.1)));
	const speechLevel = Math.sqrt(energies.at(-1)!);
	return speechLevel / noiseFloor < 6;
}
