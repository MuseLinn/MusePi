/**
 * Contract test: the percentage projection every usage surface reads
 * (`projectCompactionThreshold`) reports the trigger the agent will actually
 * apply — including the per-model `compaction.modelThresholds` layer.
 *
 * Failure mode defended: a popover that writes `compaction.thresholdPercent`
 * while a model entry (or a global token cap) silently wins. The projection
 * must name the effective percent, the mode that produced it, and the layer a
 * write has to target.
 */
import { describe, expect, test } from "bun:test";
import type { CompactionSettings } from "../src/config/settings";
import { projectCompactionThreshold } from "../src/session/compaction-threshold-view";

const MODEL = { provider: "acme", id: "wide" };
const WINDOW = 200_000;

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

describe("projectCompactionThreshold", () => {
	test("legacy reserve policy reports its effective share as auto", () => {
		const view = projectCompactionThreshold(settings(), WINDOW, MODEL);
		expect(view).not.toBeNull();
		// default reserve = max(15% of the window, 16384) = 30000.
		expect(view?.thresholdTokens).toBe(170_000);
		expect(view?.thresholdPercent).toBeCloseTo(85, 5);
		expect(view?.thresholdMode).toBe("auto");
		expect(view?.thresholdScope).toBe("global");
		expect(view?.thresholdValuePercent).toBeNull();
	});

	test("a configured percentage scales with the window", () => {
		const view = projectCompactionThreshold(settings({ thresholdPercent: 40 }), WINDOW, MODEL);
		expect(view?.thresholdTokens).toBe(80_000);
		expect(view?.thresholdPercent).toBeCloseTo(40, 5);
		expect(view?.thresholdMode).toBe("percent");
		expect(view?.thresholdScope).toBe("global");
		expect(view?.thresholdValuePercent).toBe(40);
	});

	test("a global token cap is fixed and cannot scale", () => {
		const view = projectCompactionThreshold(settings({ thresholdTokens: 100_000 }), WINDOW, MODEL);
		expect(view?.thresholdTokens).toBe(100_000);
		expect(view?.thresholdPercent).toBeCloseTo(50, 5);
		expect(view?.thresholdMode).toBe("fixed");
		expect(view?.thresholdScope).toBe("global");
	});

	test("a per-model percentage replaces the global threshold and names its layer", () => {
		const view = projectCompactionThreshold(
			settings({ thresholdPercent: 40, modelThresholds: { "acme/wide": "55%" } }),
			WINDOW,
			MODEL,
		);
		expect(view?.thresholdTokens).toBe(110_000);
		expect(view?.thresholdMode).toBe("percent");
		expect(view?.thresholdScope).toBe("model");
		expect(view?.thresholdValuePercent).toBe(55);
		expect(view?.thresholdModelKey).toBe("acme/wide");
	});

	test("a per-model fixed trigger stays exact", () => {
		const view = projectCompactionThreshold(
			settings({ thresholdPercent: 40, modelThresholds: { "acme/wide": "f90000" } }),
			WINDOW,
			MODEL,
		);
		expect(view?.thresholdTokens).toBe(90_000);
		expect(view?.thresholdMode).toBe("fixed");
		expect(view?.thresholdScope).toBe("model");
	});

	test("a per-model token base still scales by the global percentage", () => {
		const view = projectCompactionThreshold(
			settings({ thresholdPercent: 40, modelThresholds: { "acme/wide": 400_000 } }),
			WINDOW,
			MODEL,
		);
		// The base (400K) is capped by the real window, then scaled by 40%.
		expect(view?.thresholdTokens).toBe(80_000);
		expect(view?.thresholdMode).toBe("percent");
		expect(view?.thresholdScope).toBe("global");
	});

	test("model entries are ignored when their toggle is off", () => {
		const view = projectCompactionThreshold(
			settings({
				thresholdPercent: 40,
				modelThresholdsEnabled: false,
				modelThresholds: { "acme/wide": "55%" },
			}),
			WINDOW,
			MODEL,
		);
		expect(view?.thresholdValuePercent).toBe(40);
		expect(view?.thresholdScope).toBe("global");
		expect(view?.thresholdModelKey).toBeNull();
	});

	test("no window or disabled compaction yields no projection", () => {
		expect(projectCompactionThreshold(settings(), 0, MODEL)).toBeNull();
		expect(projectCompactionThreshold(settings({ enabled: false }), WINDOW, MODEL)).toBeNull();
	});
});
