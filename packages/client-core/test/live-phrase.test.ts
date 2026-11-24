import { describe, expect, it } from "bun:test";
import { livePhraseFor, phraseAt, phraseHoldMs } from "../src/components/transcript/live-phrase";
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

const base = { working: true, streaming: false, approvals: 0, paused: false };

describe("livePhraseFor", () => {
	it("puts a paused session first", () => {
		expect(livePhraseFor({ ...base, paused: true, approvals: 2, toolName: "bash" }).phase).toBe("paused");
	});
	it("puts a pending approval above tool activity", () => {
		expect(livePhraseFor({ ...base, approvals: 1, toolName: "bash" }).phase).toBe("awaiting");
	});
	it("puts a streaming reply above tool activity", () => {
		expect(livePhraseFor({ ...base, streaming: true, toolName: "bash" }).phase).toBe("reply");
	});
	it("classifies a running tool by its activity kind", () => {
		expect(livePhraseFor({ ...base, toolName: "grep" }).phase).toBe("tool:searching");
		expect(livePhraseFor({ ...base, toolName: "read" }).phase).toBe("tool:reading");
		expect(livePhraseFor({ ...base, toolName: "bash" }).phase).toBe("tool:running-commands");
	});
	it("prefers a structured tool kind over the name", () => {
		expect(livePhraseFor({ ...base, toolName: "mcp__odd__thing", toolKind: "diff" }).phase).toBe("tool:writing");
	});
	it("falls back to thinking when working without a tool", () => {
		expect(livePhraseFor(base).phase).toBe("thinking");
	});
	it("leads with the canonical phrase and offers alternates", () => {
		const phrase = livePhraseFor({ ...base, toolName: "grep" });
		expect(phrase.phrases[0]).toBe(t("transcript.phaseSearching"));
		expect(phrase.phrases.length).toBeGreaterThan(1);
	});
	it("says nothing about tools when the session is idle", () => {
		expect(livePhraseFor({ ...base, working: false }).phase).toBe("idle");
	});
});

describe("phraseAt", () => {
	const pool = ["A", "B", "C"];
	it("returns the canonical phrase at step 0", () => {
		expect(phraseAt(pool, "seed", 0)).toBe("A");
	});
	it("is deterministic for the same seed and step", () => {
		expect(phraseAt(pool, "seed", 3)).toBe(phraseAt(pool, "seed", 3));
	});
	it("never repeats the previous phrase", () => {
		for (let step = 1; step < 12; step++) {
			expect(phraseAt(pool, "seed", step)).not.toBe(phraseAt(pool, "seed", step - 1));
		}
	});
	it("cycles back to the canonical phrase", () => {
		// 3 phrases → the cycle is the 2 alternates plus the canonical one.
		const seen = [1, 2, 3].map(step => phraseAt(pool, "seed", step));
		expect(new Set(seen).size).toBe(3);
	});
	it("returns an empty string for an empty pool", () => {
		expect(phraseAt([], "seed", 2)).toBe("");
	});
});

describe("phraseHoldMs", () => {
	it("holds each phrase between 4 and 6 seconds", () => {
		for (let step = 0; step < 20; step++) {
			const hold = phraseHoldMs("seed", step);
			expect(hold).toBeGreaterThanOrEqual(4000);
			expect(hold).toBeLessThanOrEqual(6000);
		}
	});
	it("varies across steps so rows do not switch in lockstep", () => {
		const holds = new Set([0, 1, 2, 3, 4].map(step => phraseHoldMs("seed", step)));
		expect(holds.size).toBeGreaterThan(1);
	});
});
