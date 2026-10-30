import type { AudioClip } from "./corpus";

function units(text: string, unit: "char" | "word"): string[] {
	return unit === "char" ? Array.from(text.normalize("NFC")) : text.normalize("NFC").trim().split(/\s+/u);
}

export function levenshteinRate(reference: string, actual: string, unit: "char" | "word"): number {
	const expected = units(reference, unit);
	const observed = units(actual, unit);
	if (expected.length === 0 || (expected.length === 1 && expected[0] === ""))
		throw new Error("Reference must not be empty");
	let previous = Array.from({ length: observed.length + 1 }, (_, index) => index);
	for (let i = 1; i <= expected.length; i++) {
		const current = new Array<number>(observed.length + 1);
		current[0] = i;
		for (let j = 1; j <= observed.length; j++) {
			const substitution = previous[j - 1]! + (expected[i - 1] === observed[j - 1] ? 0 : 1);
			current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
		}
		previous = current;
	}
	return previous[observed.length]! / expected.length;
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) throw new Error("Percentile input must not be empty");
	if (!(p > 0 && p <= 1)) throw new Error("Percentile must be in (0, 1]");
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * p) - 1]!;
}

export function mixClips(
	target: AudioClip,
	interferer: AudioClip,
	targetGain: number,
	interfererGain: number,
): AudioClip {
	if (target.sampleRate !== interferer.sampleRate) throw new Error("Cannot mix clips with different sample rates");
	if (!Number.isFinite(targetGain) || !Number.isFinite(interfererGain)) throw new Error("Mix gains must be finite");
	const samples = new Float32Array(Math.max(target.samples.length, interferer.samples.length));
	for (let i = 0; i < samples.length; i++) {
		const mixed = (target.samples[i] ?? 0) * targetGain + (interferer.samples[i] ?? 0) * interfererGain;
		samples[i] = Math.max(-1, Math.min(1, mixed));
	}
	return { samples, sampleRate: 16_000 };
}
