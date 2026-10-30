import { describe, expect, it } from "bun:test";
import { decideSpeakerGate, shouldEnhanceAudio } from "@musepi/pi-coding-agent/voice/frontend/gate";

const thresholds = { acceptThreshold: 0.7, rejectThreshold: 0.5 };

describe("speaker gate", () => {
	it("rejects audio with no target speech", () => {
		expect(decideSpeakerGate({ targetMs: 0, score: null, ...thresholds })).toEqual({
			state: "reject",
			score: null,
			autoSubmit: false,
		});
	});

	it("keeps target speech below one second uncertain", () => {
		expect(decideSpeakerGate({ targetMs: 999, score: 0.99, ...thresholds }).state).toBe("uncertain");
	});

	it("rejects scores below the reject threshold", () => {
		expect(decideSpeakerGate({ targetMs: 1500, score: 0.49, ...thresholds }).state).toBe("reject");
	});

	it("keeps scores between thresholds uncertain", () => {
		expect(decideSpeakerGate({ targetMs: 1500, score: 0.5, ...thresholds }).state).toBe("uncertain");
	});

	it("accepts scores at the accept threshold", () => {
		expect(decideSpeakerGate({ targetMs: 1500, score: 0.7, ...thresholds })).toEqual({
			state: "accept",
			score: 0.7,
			autoSubmit: true,
		});
	});

	it("does not accept a missing score", () => {
		expect(decideSpeakerGate({ targetMs: 1500, score: null, ...thresholds }).autoSubmit).toBe(false);
	});
});

describe("enhancement gate", () => {
	it("preserves high-SNR audio instead of degrading it", () => {
		const audio = new Float32Array(16_000).fill(0.001);
		audio.fill(0.2, 3_200);
		expect(shouldEnhanceAudio(audio)).toBe(false);
	});

	it("enhances audio without a clean noise floor", () => {
		const audio = new Float32Array(16_000);
		for (let index = 0; index < audio.length; index++) audio[index] = Math.floor(index / 320) % 2 === 0 ? 0.05 : 0.1;
		expect(shouldEnhanceAudio(audio)).toBe(true);
	});
});
