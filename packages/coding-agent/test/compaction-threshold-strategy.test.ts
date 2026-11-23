/**
 * Contract test for the compaction threshold strategy seam: the built-in
 * per-model rule runs first, a plugin strategy only sees models it left alone,
 * and an unregistered strategy cannot keep shaping the policy.
 */
import { describe, expect, test } from "bun:test";
import type { CompactionSettings } from "../src/config/settings";
import {
	compactionThresholdStrategyKey,
	listCompactionThresholdStrategies,
	registerCompactionThresholdStrategy,
	resolveCompactionThreshold,
} from "../src/session/compaction-threshold-strategy";
import { resolveModelCompactionSettings } from "../src/session/model-compaction-threshold";

const MODEL = { provider: "acme", id: "wide" };

function settings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return {
		enabled: true,
		methodOrder: [],
		thresholdPercent: -1,
		thresholdTokens: -1,
		reserveTokens: undefined,
		keepRecentTokens: 20_000,
		midTurnEnabled: true,
		asyncEnabled: true,
		speculationCacheGuard: false,
		modelThresholdsEnabled: true,
		modelThresholds: {},
		experimentalContextManagement: false,
		handoffSaveToDisk: false,
		autoContinue: true,
		remoteEndpoint: undefined,
		remoteStreamingV2Enabled: true,
		v2RetainedMessageBudget: 0,
		idleEnabled: false,
		idleThresholdTokens: 0,
		idleTimeoutSeconds: 0,
		supersedeReads: false,
		dropUseless: false,
		...overrides,
	};
}

describe("compaction threshold strategies", () => {
	test("the built-in per-model rule is registered first", () => {
		expect(listCompactionThresholdStrategies()[0]?.id).toBe("modelThresholds");
	});

	test("the built-in rule still wins for a model it names", () => {
		const resolved = resolveModelCompactionSettings(
			settings({ thresholdPercent: 40, modelThresholds: { "acme/wide": "55%" } }),
			MODEL,
		);
		expect(resolved.thresholdPercent).toBe(55);
	});

	test("a plugin strategy only sees models the built-in rule left alone", () => {
		const seen: string[] = [];
		const dispose = registerCompactionThresholdStrategy({
			id: "test-dirs",
			resolve: ({ model, settings: base }) => {
				seen.push(`${model?.provider}/${model?.id}`);
				return base.thresholdPercent === 40 ? { ...base, thresholdPercent: 70 } : undefined;
			},
		});
		try {
			// The built-in rule claims this model, so the plugin is never asked.
			const claimed = resolveModelCompactionSettings(
				settings({ thresholdPercent: 40, modelThresholds: { "acme/wide": "55%" } }),
				MODEL,
			);
			expect(claimed.thresholdPercent).toBe(55);
			expect(seen).toEqual([]);

			// No model entry: the plugin's answer applies.
			const unclaimed = resolveModelCompactionSettings(settings({ thresholdPercent: 40 }), MODEL);
			expect(unclaimed.thresholdPercent).toBe(70);
			expect(seen).toEqual(["acme/wide"]);
		} finally {
			dispose();
		}
	});

	test("an unregistered strategy stops shaping the policy", () => {
		const dispose = registerCompactionThresholdStrategy({
			id: "test-temp",
			resolve: () => ({ ...settings(), thresholdPercent: 91 }),
		});
		expect(resolveCompactionThreshold(settings(), MODEL).thresholdPercent).toBe(91);
		dispose();
		expect(resolveCompactionThreshold(settings(), MODEL).thresholdPercent).toBe(-1);
	});

	test("a duplicate strategy id is refused", () => {
		expect(() => registerCompactionThresholdStrategy({ id: "modelThresholds", resolve: () => undefined })).toThrow(
			/already registered/,
		);
	});

	test("the cache key distinguishes models and the strategy set", () => {
		const base = settings();
		expect(compactionThresholdStrategyKey(base, MODEL)).not.toBe(
			compactionThresholdStrategyKey(base, { provider: "acme", id: "narrow" }),
		);
		const before = compactionThresholdStrategyKey(base, MODEL);
		const dispose = registerCompactionThresholdStrategy({ id: "test-key", resolve: () => undefined });
		expect(compactionThresholdStrategyKey(base, MODEL)).not.toBe(before);
		dispose();
		expect(compactionThresholdStrategyKey(base, MODEL)).toBe(before);
	});
});
