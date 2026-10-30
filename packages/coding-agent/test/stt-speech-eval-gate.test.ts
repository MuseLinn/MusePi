import { describe, expect, it } from "bun:test";
import { decideGate } from "@musepi/pi-coding-agent/stt/eval/gate";

const thresholds = { acceptThreshold: 0.75, rejectThreshold: 0.35 };

describe("speaker gate", () => {
	it("rejects interferer-only audio even when ASR would be empty", () => {
		expect(decideGate({ targetMs: 0, score: null, ...thresholds })).toEqual({
			state: "reject",
			score: null,
			autoSubmit: false,
		});
	});

	it("keeps short target speech uncertain", () => {
		expect(decideGate({ targetMs: 999, score: 0.99, ...thresholds })).toEqual({
			state: "uncertain",
			score: 0.99,
			autoSubmit: false,
		});
	});

	it("rejects scores below the reject threshold", () => {
		expect(decideGate({ targetMs: 1200, score: 0.2, ...thresholds }).state).toBe("reject");
	});

	it("keeps scores between thresholds uncertain", () => {
		expect(decideGate({ targetMs: 1200, score: 0.5, ...thresholds }).state).toBe("uncertain");
	});

	it("accepts scores at the accept threshold", () => {
		expect(decideGate({ targetMs: 1200, score: 0.75, ...thresholds })).toEqual({
			state: "accept",
			score: 0.75,
			autoSubmit: true,
		});
	});

	it("keeps missing scores uncertain instead of accepting them", () => {
		expect(decideGate({ targetMs: 1200, score: null, ...thresholds }).autoSubmit).toBe(false);
	});
});
