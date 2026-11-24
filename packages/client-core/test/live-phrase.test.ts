import { describe, expect, it } from "bun:test";
import { t } from "../src/i18n/index.js";

describe("tail presence i18n keys", () => {
	it("resolves every phase label", () => {
		for (const key of [
			"transcript.phaseThinking",
			"transcript.phaseReading",
			"transcript.phaseSearching",
			"transcript.phaseWriting",
			"transcript.phaseCommands",
			"transcript.phaseBrowsing",
			"transcript.phaseComputer",
			"transcript.phaseMessaging",
			"transcript.phaseWaiting",
			"transcript.phaseReply",
			"transcript.phaseWorking",
		] as const) {
			expect(t(key)).not.toBe(key);
		}
	});

	it("resolves every alternate phrase", () => {
		for (const key of [
			"transcript.altMulling",
			"transcript.altPiecing",
			"transcript.altWeighing",
			"transcript.altNarrowing",
			"transcript.altSkimming",
			"transcript.altDrafting",
			"transcript.altCheckingOutput",
			"transcript.altTakingALook",
			"transcript.altClickingThrough",
			"transcript.altLookingItUp",
		] as const) {
			expect(t(key)).not.toBe(key);
		}
	});

	it("resolves the quiet-state strings and interpolates their params", () => {
		expect(t("transcript.workingQuiet")).not.toBe("transcript.workingQuiet");
		expect(t("transcript.workingSilent", { minutes: 2 })).toContain("2");
		expect(t("transcript.presenceSteps", { files: 3, commands: 2 })).toContain("3");
		expect(t("transcript.presenceDetailLabel")).not.toBe("transcript.presenceDetailLabel");
	});
});
