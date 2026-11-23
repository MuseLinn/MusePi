/**
 * Contract test for the compaction-method provider seam: a registered method
 * joins the ordered picker and the availability scan, an unknown id degrades
 * instead of breaking a pass, and a duplicate registration is refused.
 */
import { describe, expect, test } from "bun:test";
import type { CompactionSettings } from "../src/config/settings-schema";
import {
	getCompactionMethodProvider,
	isCompactionMethod,
	listCompactionMethodProviders,
	registerCompactionMethodProvider,
} from "../src/session/compaction-method-provider";
import {
	COMPACTION_METHOD_CHOICES,
	DEFAULT_COMPACTION_METHOD_ORDER,
	resolveCompactionMethodOrder,
	resolveMethodSettings,
	resolveSpeculationMethod,
} from "../src/session/compaction-methods";

function settings(overrides: Partial<CompactionSettings> = {}): CompactionSettings {
	return {
		enabled: true,
		methodOrder: [...DEFAULT_COMPACTION_METHOD_ORDER],
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
	} as CompactionSettings;
}

describe("compaction method providers", () => {
	test("registers the five shipped methods", () => {
		const ids = listCompactionMethodProviders().map(provider => provider.id);
		expect(ids).toEqual(["remote", "snapcompact", "handoff", "soft", "shake"]);
		for (const id of DEFAULT_COMPACTION_METHOD_ORDER) expect(isCompactionMethod(id)).toBe(true);
	});

	test("the picker carries copy keys, not English sentences", () => {
		for (const choice of COMPACTION_METHOD_CHOICES) {
			expect(choice.label).toStartWith("settings.compaction.method.");
			expect(choice.label).toEndWith(".title");
			expect(choice.description).toEndWith(".desc");
		}
	});

	test("a plugin-contributed method joins the order and the speculation scan", () => {
		const dispose = registerCompactionMethodProvider({
			id: "test-summarize",
			label: "settings.compaction.method.soft.title",
			description: "settings.compaction.method.soft.desc",
			available: () => true,
			run: async () => ({ decline: "test double" }),
		});
		try {
			expect(isCompactionMethod("test-summarize")).toBe(true);
			// A contributed method runs through the portable summary strategy.
			expect(resolveMethodSettings(settings(), "test-summarize").strategy).toBe("context-full");
			// It needs a remote LLM call, so it is a speculation candidate.
			expect(resolveSpeculationMethod(undefined, settings({ methodOrder: ["test-summarize"] }))).toBe(
				"test-summarize",
			);
		} finally {
			dispose();
		}
		expect(isCompactionMethod("test-summarize")).toBe(false);
	});

	test("unregistering a method drops it from configuration instead of failing", () => {
		const dispose = registerCompactionMethodProvider({
			id: "test-drop",
			label: "settings.compaction.method.soft.title",
			description: "settings.compaction.method.soft.desc",
			available: () => true,
			run: async () => ({ decline: "test double" }),
		});
		expect(resolveCompactionMethodOrder(["test-drop", "soft"])).toEqual(["test-drop", "soft"]);
		dispose();
		// The pass keeps running with the remaining methods.
		expect(resolveCompactionMethodOrder(["test-drop", "soft"])).toEqual(["soft"]);
	});

	test("a duplicate id is refused rather than silently replacing the incumbent", () => {
		const provider = {
			id: "soft",
			label: "x",
			description: "y",
			available: () => true,
			run: async () => ({ decline: "test double" }),
		};
		expect(() => registerCompactionMethodProvider(provider)).toThrow(/already registered/);
		// The shipped provider is untouched.
		expect(getCompactionMethodProvider("soft")?.description).toBe("settings.compaction.method.soft.desc");
	});
});
