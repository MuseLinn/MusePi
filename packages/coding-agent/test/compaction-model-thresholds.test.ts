import { describe, expect, it } from "bun:test";
import { resolveThresholdTokens } from "@musepi/pi-agent-core/compaction";
import {
	applyModelCompactionThreshold,
	type CompactionThresholdPair,
	matchModelCompactionThreshold,
	parseCompactionPointInput,
	parseModelCompactionEntry,
	validateModelCompactionThresholds,
} from "@musepi/pi-coding-agent/config/compaction-threshold";

const BASE: CompactionThresholdPair & {
	enabled: boolean;
	reserveTokens: number | undefined;
	keepRecentTokens: number;
	baseWindowTokens?: number;
} = {
	enabled: true,
	thresholdPercent: 50,
	thresholdTokens: -1,
	reserveTokens: undefined,
	keepRecentTokens: 20_000,
};

describe("compaction.modelThresholds entries", () => {
	it("validates token, fixed, and percentage entries plus prefix keys", () => {
		const thresholds = validateModelCompactionThresholds({
			"anthropic/claude-sonnet-4-5": 400_000,
			"openai/gpt-6": "f200000",
			"openrouter/anthropic/*": "80%",
			"deepseek/*": null,
		});

		expect(thresholds["anthropic/claude-sonnet-4-5"]).toEqual({ thresholdPercent: -1, thresholdTokens: 400_000 });
		expect(thresholds["openai/gpt-6"]).toEqual({ thresholdPercent: -1, thresholdTokens: 200_000, fixed: true });
		expect(thresholds["openrouter/anthropic/*"]).toEqual({ thresholdPercent: 80, thresholdTokens: -1 });
		expect(thresholds["deepseek/*"]).toBeUndefined();
	});

	it("rejects malformed selectors and entries", () => {
		expect(() => validateModelCompactionThresholds({ "no-slash": 1 })).toThrow(/provider\/model-id/);
		expect(() => validateModelCompactionThresholds({ "a/*/b": 1 })).toThrow(/only allowed as the last character/);
		expect(() => validateModelCompactionThresholds({ "a/b": "101%" })).toThrow(/Invalid compaction\.modelThresholds/);
		expect(() => validateModelCompactionThresholds({ "a/b": 0 })).toThrow(/Invalid compaction\.modelThresholds/);
	});

	it("prefers an exact model key over the longest matching prefix", () => {
		const raw = {
			"anthropic/*": "70%",
			"anthropic/claude-*": "75%",
			"anthropic/claude-sonnet-4-5": "80%",
		};
		expect(matchModelCompactionThreshold(raw, { provider: "anthropic", id: "claude-sonnet-4-5" })?.key).toBe(
			"anthropic/claude-sonnet-4-5",
		);
		expect(matchModelCompactionThreshold(raw, { provider: "anthropic", id: "claude-opus-5" })?.key).toBe(
			"anthropic/claude-*",
		);
		expect(matchModelCompactionThreshold(raw, { provider: "openai", id: "gpt-6" })).toBeUndefined();
	});

	it("applies a token base, a fixed trigger, or a percentage", () => {
		const base = applyModelCompactionThreshold(BASE, { "a/b": 400_000 }, { provider: "a", id: "b" });
		expect(base.thresholdTokens).toBe(-1);
		expect(base.thresholdPercent).toBe(50);
		expect(base.baseWindowTokens).toBe(400_000);

		const fixed = applyModelCompactionThreshold(BASE, { "a/b": "f150000" }, { provider: "a", id: "b" });
		expect(fixed.thresholdTokens).toBe(150_000);
		expect(fixed.thresholdPercent).toBe(-1);
		expect(fixed.baseWindowTokens).toBeUndefined();

		const percent = applyModelCompactionThreshold(BASE, { "a/b": "80%" }, { provider: "a", id: "b" });
		expect(percent.thresholdPercent).toBe(80);
		expect(percent.thresholdTokens).toBe(-1);
	});

	it("scales the percentage and reserve policy against the model's token base", () => {
		// 50% of the 400K base, not of the real 1M window.
		expect(resolveThresholdTokens(1_000_000, { ...BASE, baseWindowTokens: 400_000 })).toBe(200_000);
		// No percentage: the base less the 15% reserve floor.
		expect(resolveThresholdTokens(1_000_000, { ...BASE, thresholdPercent: -1, baseWindowTokens: 400_000 })).toBe(
			340_000,
		);
		// A fixed trigger still uses the real window.
		expect(resolveThresholdTokens(1_000_000, { ...BASE, thresholdTokens: 150_000 })).toBe(150_000);
	});

	it("parses and formats typed compaction points", () => {
		expect(parseCompactionPointInput("")).toBeNull();
		expect(parseCompactionPointInput("90k")).toBe(90_000);
		expect(parseCompactionPointInput("1m")).toBe(1_000_000);
		expect(parseCompactionPointInput("f400k")).toBe("f400000");
		expect(parseCompactionPointInput("80%")).toBe("80%");
		expect(parseCompactionPointInput("400000")).toBe(400_000);
		expect(parseModelCompactionEntry("f400000")).toEqual({
			thresholdPercent: -1,
			thresholdTokens: 400_000,
			fixed: true,
		});
		expect(() => parseCompactionPointInput("wide")).toThrow(/Invalid compaction point/);
	});
});
