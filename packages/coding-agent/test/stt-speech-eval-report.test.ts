import { describe, expect, it } from "bun:test";
import {
	type BenchmarkRow,
	benchmarkAcceptanceFailures,
	mergeBenchmarkRows,
	summarizeBenchmark,
} from "@musepi/pi-coding-agent/stt/eval/report";

function row(patch: Partial<BenchmarkRow> = {}): BenchmarkRow {
	return {
		itemId: "clean-1",
		kind: "clean",
		candidate: "candidate-a",
		gate: { state: "accept", score: 0.9, autoSubmit: true },
		cer: null,
		wer: null,
		audioMs: 1000,
		endpointMs: 100,
		loadMs: 900,
		inferenceMs: 250,
		rssBytes: 1000,
		...patch,
	};
}

describe("speech benchmark report", () => {
	it("counts non-target auto-submits even without ASR text", () => {
		const rows = [row({ kind: "interferer", cer: null, wer: null })];
		expect(summarizeBenchmark(rows).nonTargetAutoSubmits).toBe(1);
	});

	it("excludes cold model load from steady-state RTF", () => {
		const rows = [row(), row({ itemId: "clean-2", inferenceMs: 150, endpointMs: 300 })];
		const summary = summarizeBenchmark(rows);
		expect(summary.rtf).toBe(0.2);
		expect(summary.p95EndpointMs).toBe(300);
	});

	it("compares clean error rates with the same item's unprocessed baseline", () => {
		const rows = [row({ candidate: "passthrough", cer: 0.1 }), row({ candidate: "candidate-a", cer: 0.125 })];
		expect(summarizeBenchmark(rows).cleanRelativeRegression).toBeCloseTo(0.25);
	});

	it("keeps other candidates' rows when merging a successful run", () => {
		const existing = [
			row({ candidate: "candidate-b", itemId: "old-a" }),
			row({ candidate: "candidate-a", itemId: "old-b" }),
		];
		const merged = mergeBenchmarkRows(existing, "candidate-a", [row({ candidate: "candidate-a", itemId: "new-c" })]);
		expect(merged.map(entry => `${entry.candidate}:${entry.itemId}`)).toEqual([
			"candidate-b:old-a",
			"candidate-a:new-c",
		]);
	});

	it("replaces stale baseline rows for the current corpus items", () => {
		const existing = [
			row({ candidate: "passthrough", itemId: "clean-1", cer: 0.5 }),
			row({ candidate: "candidate-b", itemId: "clean-1", cer: 0.4 }),
		];
		const merged = mergeBenchmarkRows(existing, "candidate-a", [
			row({ candidate: "candidate-a", itemId: "clean-1", cer: 0.1 }),
		]);
		expect(merged.map(entry => `${entry.candidate}:${entry.itemId}:${entry.cer}`)).toEqual([
			"candidate-b:clean-1:0.4",
			"candidate-a:clean-1:0.1",
		]);
	});

	it("fails acceptance when no clean comparison is available", () => {
		expect(
			benchmarkAcceptanceFailures({
				summary: { rtf: 0.5, p95EndpointMs: 100, cleanRelativeRegression: null },
				nonTargetAutoSubmits: 0,
				noiseChange: -0.1,
				overlapChange: -0.1,
				maxRssBytes: 1000,
			}),
		).toContain("clean comparison unavailable");
	});
});
