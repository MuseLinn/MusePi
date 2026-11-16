import { describe, expect, it } from "bun:test";
import type { Model } from "@musepi/pi-ai";
import { buildModel } from "@musepi/pi-catalog/build";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ModelControls, type ModelControlsHost } from "@musepi/pi-coding-agent/session/model-controls";

function sharedIdModel(provider: string): Model<"anthropic-messages"> {
	return buildModel({
		id: "gpt-4o",
		name: `GPT-4o (${provider})`,
		api: "anthropic-messages",
		provider,
		baseUrl: `https://${provider}.example.com`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 4096,
	});
}

describe("model resolution notices", () => {
	it("shows an ambiguous bare-id resolution once per session", () => {
		const openai = sharedIdModel("openai");
		const azure = sharedIdModel("azure");
		const notices: Array<{ level: string; message: string; source?: string }> = [];
		const host: ModelControlsHost = {
			agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} } as never,
			settings: Settings.isolated({ modelRoles: { default: "gpt-4o" } }),
			modelRegistry: { getAvailable: () => [openai, azure] } as never,
			sessionManager: {
				appendThinkingLevelChange: () => {},
				getLastModelChangeRole: () => undefined,
			} as never,
			providerSessionState: new Map(),
			model: () => openai,
			sessionId: () => "s1",
			promptGeneration: () => 1,
			resolveActiveEditMode: () => "normal" as never,
			syncAfterModelChange: async () => {},
			setModelWithProviderSessionReset: async () => {},
			clearActiveRetryFallback: () => {},
			clearInheritedProviderPromptCacheKey: () => {},
			magicKeywordEnabled: () => false,
			emit: () => {},
			emitSessionEvent: async () => {},
			emitNotice: (level, message, source) => {
				notices.push({ level, message, source });
			},
		};
		const controls = new ModelControls(host, {});

		const cycle = controls.getRoleModelCycle(["default"]);
		expect(cycle?.models).toHaveLength(1);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.level).toBe("warning");
		expect(notices[0]?.source).toBe("model");
		expect(notices[0]?.message).toContain("served by multiple providers");

		// The role ladder is rebuilt every turn; the same warning must not repeat.
		controls.getRoleModelCycle(["default"]);
		expect(notices).toHaveLength(1);
	});
});
