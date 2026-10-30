import type { CorpusItem } from "./corpus";
import type { GateDecision } from "./gate";
import { percentile } from "./metrics";

export interface BenchmarkRow {
	itemId: string;
	kind: CorpusItem["kind"];
	candidate: string;
	gate: GateDecision;
	cer: number | null;
	wer: number | null;
	audioMs: number;
	endpointMs: number;
	loadMs: number;
	inferenceMs: number;
	rssBytes: number;
}

export function summarizeBenchmark(rows: BenchmarkRow[]): {
	rtf: number;
	p95EndpointMs: number;
	cleanRelativeRegression: number | null;
	nonTargetAutoSubmits: number;
} {
	const processed = rows.filter(row => row.candidate !== "passthrough");
	const measured = processed.length > 0 ? processed : rows;
	const audioMs = measured.reduce((sum, row) => sum + row.audioMs, 0);
	const inferenceMs = measured.reduce((sum, row) => sum + row.inferenceMs, 0);
	const regressions: number[] = [];
	for (const row of processed.filter(entry => entry.kind === "clean")) {
		const baseline = rows.find(entry => entry.itemId === row.itemId && entry.candidate === "passthrough");
		if (!baseline) continue;
		for (const metric of ["cer", "wer"] as const) {
			const actual = row[metric];
			const expected = baseline[metric];
			if (actual !== null && expected !== null && expected > 0) regressions.push((actual - expected) / expected);
		}
	}
	return {
		rtf: audioMs > 0 ? inferenceMs / audioMs : 0,
		p95EndpointMs: percentile(
			measured.map(row => row.endpointMs),
			0.95,
		),
		cleanRelativeRegression:
			regressions.length > 0 ? regressions.reduce((sum, value) => sum + value, 0) / regressions.length : null,
		nonTargetAutoSubmits: rows.filter(row => row.kind === "interferer" && row.gate.autoSubmit).length,
	};
}

export function mergeBenchmarkRows(existing: BenchmarkRow[], candidate: string, rows: BenchmarkRow[]): BenchmarkRow[] {
	const currentIds = new Set(rows.map(row => row.itemId));
	return [
		...existing.filter(
			row => row.candidate !== candidate && (!currentIds.has(row.itemId) || row.candidate !== "passthrough"),
		),
		...rows,
	];
}

export function benchmarkAcceptanceFailures(input: {
	summary: { rtf: number; p95EndpointMs: number; cleanRelativeRegression: number | null };
	nonTargetAutoSubmits: number;
	noiseChange: number | null;
	overlapChange: number | null;
	maxRssBytes: number;
}): string[] {
	const failures: string[] = [];
	if (input.summary.rtf > 0.75) failures.push(`RTF ${input.summary.rtf} exceeds 0.75`);
	if (input.summary.p95EndpointMs > 500)
		failures.push(`endpoint P95 ${input.summary.p95EndpointMs} ms exceeds 500 ms`);
	if (input.nonTargetAutoSubmits > 0) failures.push(`${input.nonTargetAutoSubmits} non-target auto-submits`);
	if (input.summary.cleanRelativeRegression === null) failures.push("clean comparison unavailable");
	else if (input.summary.cleanRelativeRegression > 0.02) {
		failures.push(`clean regression ${input.summary.cleanRelativeRegression} exceeds 2%`);
	}
	if (input.noiseChange === null || input.noiseChange >= 0) failures.push("noise did not improve over baseline");
	if (input.overlapChange === null || input.overlapChange >= 0) failures.push("overlap did not improve over baseline");
	if (input.maxRssBytes > 1_073_741_824) failures.push("candidate RSS exceeds 1 GB");
	return failures;
}
