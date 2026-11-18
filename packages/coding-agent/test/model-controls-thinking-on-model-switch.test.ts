import { describe, expect, it } from "bun:test";
import { Effort, type Model } from "@musepi/pi-ai";
import { ModelControls, type ModelControlsHost } from "@musepi/pi-coding-agent/session/model-controls";

/**
 * A model switch must not leave the session configured at a thinking rung the
 * new model does not offer. Reported case: a model with `medium` switched to
 * one whose ladder is low/high/max, and the chip kept reading “medium” while
 * the ladder already showed the new model's three rungs.
 */

function model(id: string, efforts: Effort[] | null): Model {
	return {
		provider: "test",
		id,
		name: id,
		reasoning: efforts !== null,
		...(efforts ? { thinking: { mode: "effort", efforts } } : {}),
	} as unknown as Model;
}

interface State {
	model: Model;
	emitted: unknown[];
	appended: unknown[];
}

function createHost(state: State): ModelControlsHost {
	return {
		agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} } as never,
		settings: { set: () => {}, getStorage: () => undefined } as never,
		modelRegistry: {
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (m: Model) => m,
			clearSuppressedSelector: () => {},
		} as never,
		sessionManager: {
			appendThinkingLevelChange: (...args: unknown[]) => void state.appended.push(args),
			appendModelChange: (...args: unknown[]) => void state.appended.push(args),
		} as never,
		providerSessionState: new Map(),
		model: () => state.model,
		sessionId: () => "s1",
		promptGeneration: () => 1,
		resolveActiveEditMode: () => "normal" as never,
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async (m: Model) => {
			state.model = m;
		},
		clearActiveRetryFallback: () => {},
		clearInheritedProviderPromptCacheKey: () => {},
		magicKeywordEnabled: () => false,
		emit: (event: unknown) => void state.emitted.push(event),
		emitSessionEvent: async () => {},
		emitNotice: () => {},
	} as ModelControlsHost;
}

describe("thinking level across a model switch", () => {
	it("falls back to a rung the new model has when the old level is missing", async () => {
		const wide = model("wide", [Effort.Low, Effort.Medium, Effort.High]);
		const narrow = model("narrow", [Effort.Low, Effort.High, Effort.Max]);
		const state: State = { model: wide, emitted: [], appended: [] };
		const controls = new ModelControls(createHost(state), { thinkingLevel: Effort.Medium });

		expect(controls.thinkingLevel).toBe(Effort.Medium);

		await controls.setModel(narrow);

		// `medium` is not on the new ladder: the session must not keep claiming it.
		expect(controls.thinkingLevel).toBe(Effort.Low);
	});

	it("keeps the level when the new model still offers it", async () => {
		const a = model("a", [Effort.Low, Effort.Medium, Effort.High]);
		const b = model("b", [Effort.Low, Effort.Medium, Effort.Max]);
		const state: State = { model: a, emitted: [], appended: [] };
		const controls = new ModelControls(createHost(state), { thinkingLevel: Effort.Medium });

		await controls.setModel(b);

		expect(controls.thinkingLevel).toBe(Effort.Medium);
	});
});
