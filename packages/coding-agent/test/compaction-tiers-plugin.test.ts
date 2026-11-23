/**
 * Contract test for the compaction-tiers plugin: the premium-long-context cap
 * applies only to models with a `cost.longContext` tier, only when the
 * effective trigger is above the cap, and never overrides an explicit
 * per-model entry.
 */
import { describe, expect, test } from "bun:test";
import type { CompactionSettings } from "../src/config/settings";
import { updateVolatileValue } from "../src/extensibility/plugins/runtime/declared-config";
import { makeVolatileRef } from "../src/plugin-config";
import { apply } from "../src/plugins/workspace/compaction-tiers/index";
import {
	listCompactionThresholdStrategies,
	registerCompactionThresholdStrategy,
} from "../src/session/compaction-threshold-strategy";
import { resolveModelCompactionSettings } from "../src/session/model-compaction-threshold";

function settings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return {
		enabled: true,
		methodOrder: [],
		thresholdPercent: 85,
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

const premium = { provider: "acme", id: "wide", cost: { longContext: { inputThreshold: 272_000 } } };
const flat = { provider: "acme", id: "small", cost: {} };

describe("compaction-tiers plugin", () => {
	test("caps a premium long-context model at the configured percentage", () => {
		const dispose = applyPlugin();
		try {
			expect(resolveModelCompactionSettings(settings({ thresholdPercent: 85 }), premium).thresholdPercent).toBe(70);
			// A model with no premium tier keeps the configured trigger.
			expect(resolveModelCompactionSettings(settings({ thresholdPercent: 85 }), flat).thresholdPercent).toBe(85);
		} finally {
			dispose();
		}
	});

	test("leaves a trigger already under the cap alone", () => {
		const dispose = applyPlugin();
		try {
			expect(resolveModelCompactionSettings(settings({ thresholdPercent: 50 }), premium).thresholdPercent).toBe(50);
		} finally {
			dispose();
		}
	});

	test("a fixed token trigger has no share of the window to cap", () => {
		const dispose = applyPlugin();
		try {
			const fixed = settings({ thresholdPercent: -1, thresholdTokens: 190_000 });
			expect(resolveModelCompactionSettings(fixed, premium).thresholdTokens).toBe(190_000);
		} finally {
			dispose();
		}
	});

	test("an explicit per-model entry still wins over the cap", () => {
		const dispose = applyPlugin();
		try {
			const explicit = settings({ thresholdPercent: 85, modelThresholds: { "acme/wide": "90%" } });
			expect(resolveModelCompactionSettings(explicit, premium).thresholdPercent).toBe(90);
		} finally {
			dispose();
		}
	});

	test("honours a configured cap percentage", () => {
		const dispose = applyPlugin({ capPercent: 60 });
		try {
			expect(resolveModelCompactionSettings(settings({ thresholdPercent: 85 }), premium).thresholdPercent).toBe(60);
		} finally {
			dispose();
		}
	});

	test("reads a volatile cap on every resolve", () => {
		const config = { capPercent: makeVolatileRef(60) };
		let dispose: (() => void) | undefined;
		apply(
			{
				registerCompactionThresholdStrategy: (
					strategy: Parameters<typeof registerCompactionThresholdStrategy>[0],
				) => {
					dispose = registerCompactionThresholdStrategy(strategy);
					return dispose;
				},
			} as never,
			config,
		);
		try {
			expect(resolveModelCompactionSettings(settings({ thresholdPercent: 85 }), premium).thresholdPercent).toBe(60);
			expect(updateVolatileValue({ config }, "capPercent", 40)).toBe(true);
			expect(resolveModelCompactionSettings(settings({ thresholdPercent: 85 }), premium).thresholdPercent).toBe(40);
		} finally {
			dispose?.();
		}
	});

	test("the strategy disappears when the plugin is unloaded", () => {
		const dispose = applyPlugin();
		dispose();
		expect(resolveModelCompactionSettings(settings({ thresholdPercent: 85 }), premium).thresholdPercent).toBe(85);
		expect(listCompactionThresholdStrategies().some(s => s.id === "compactionTiers.premiumCap")).toBe(false);
	});
});

/** Mount the plugin and return the disposer the host would keep for it. */
function applyPlugin(config?: { capPercent: number }): () => void {
	let dispose: (() => void) | undefined;
	apply(
		{
			registerCompactionThresholdStrategy: (strategy: Parameters<typeof registerCompactionThresholdStrategy>[0]) => {
				dispose = registerCompactionThresholdStrategy(strategy);
				return dispose;
			},
		} as never,
		config ? { capPercent: makeVolatileRef(config.capPercent) } : undefined,
	);
	if (!dispose) throw new Error("plugin did not register a strategy");
	return dispose;
}
