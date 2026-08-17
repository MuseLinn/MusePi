import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort, type Model } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { AUTO_THINKING } from "@musepi/pi-coding-agent/thinking";
import { ModelControls, type ModelControlsHost } from "@musepi/pi-coding-agent/session/model-controls";

// Mock the classifier so tests count real classification runs (the cache
// must skip it after the first per-model classification).
const classify = vi.fn(async () => Effort.Low);
vi.mock("@musepi/pi-coding-agent/auto-thinking/classifier", () => ({
	classifyDifficulty: () => classify(),
}));

interface HostState {
	model: Model;
	generation: number;
	emitted: unknown[];
	appended: unknown[];
}

function createHost(state: HostState): ModelControlsHost {
	return {
		agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} } as never,
		settings: {} as never,
		modelRegistry: {} as never,
		sessionManager: {
			appendThinkingLevelChange: (...args: unknown[]) => void state.appended.push(args),
		} as never,
		providerSessionState: new Map(),
		model: () => state.model,
		sessionId: () => "s1",
		promptGeneration: () => state.generation,
		resolveActiveEditMode: () => "normal" as never,
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async () => {},
		clearActiveRetryFallback: () => {},
		clearInheritedProviderPromptCacheKey: () => {},
		magicKeywordEnabled: () => false,
		emit: (event: unknown) => void state.emitted.push(event),
		emitSessionEvent: async () => {},
		emitNotice: () => {},
	};
}

function makeControls(host: ModelControlsHost): ModelControls {
	return new ModelControls(host, { thinkingLevel: AUTO_THINKING });
}

describe("auto-thinking classification cache (会话内分类后确认)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		classify.mockClear();
	});

	it("classifies once per model, then reuses the effort without another classifier call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model?.reasoning) throw new Error("fixture model must support reasoning");
		const state: HostState = { model, generation: 1, emitted: [], appended: [] };
		const controls = makeControls(createHost(state));

		await controls.applyAutoThinkingLevel("refactor the storage layer", 1);
		expect(classify).toHaveBeenCalledTimes(1);
		const firstEmitted = state.emitted.length;
		expect(firstEmitted).toBeGreaterThan(0);

		// Second message, same model, nothing changed — cache hit, NO classifier
		// call and NO new thinking_level_changed (the effort is unchanged).
		await controls.applyAutoThinkingLevel("add validation around the retry path", 1);
		expect(classify).toHaveBeenCalledTimes(1);
		expect(state.emitted.length).toBe(firstEmitted);
	});

	it("re-classifies after a manual thinking switch (再次点击)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model?.reasoning) throw new Error("fixture model must support reasoning");
		const state: HostState = { model, generation: 1, emitted: [], appended: [] };
		const controls = makeControls(createHost(state));

		await controls.applyAutoThinkingLevel("first message", 1);
		expect(classify).toHaveBeenCalledTimes(1);

		// User picks a level explicitly — setThinkingLevel resets the cache.
		controls.setThinkingLevel(Effort.High);
		await controls.applyAutoThinkingLevel("second message", 1);
		expect(classify).toHaveBeenCalledTimes(2);
	});

	it("re-classifies after a model switch (per-model key)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model?.reasoning) throw new Error("fixture model must support reasoning");
		const other = getBundledModel("anthropic", "claude-opus-4-5");
		if (!other?.reasoning) throw new Error("fixture model 2 must support reasoning");
		const state: HostState = { model, generation: 1, emitted: [], appended: [] };
		const controls = makeControls(createHost(state));

		await controls.applyAutoThinkingLevel("first message", 1);
		expect(classify).toHaveBeenCalledTimes(1);

		state.model = other;
		await controls.applyAutoThinkingLevel("after model switch", 1);
		expect(classify).toHaveBeenCalledTimes(2);
	});

	it("does not pin the session at max after an ultrathink request", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model?.reasoning) throw new Error("fixture model must support reasoning");
		const state: HostState = { model, generation: 1, emitted: [], appended: [] };
		const host = createHost(state);
		// ultrathink keyword enabled + present on the first message.
		(host as { magicKeywordEnabled: (k: string) => boolean }).magicKeywordEnabled = k => k === "ultrathink";
		const controls = makeControls(host);

		await controls.applyAutoThinkingLevel("ultrathink solve this hard problem", 1);
		// The shortcut resolved Max WITHOUT calling the classifier.
		expect(classify).toHaveBeenCalledTimes(0);

		// The next normal message must classify fresh — not inherit Max.
		await controls.applyAutoThinkingLevel("a normal follow-up", 1);
		expect(classify).toHaveBeenCalledTimes(1);
	});

	it("re-classifies after classify → ultrathink → normal (ultrathink invalidates the seeded cache)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model?.reasoning) throw new Error("fixture model must support reasoning");
		const state: HostState = { model, generation: 1, emitted: [], appended: [] };
		const host = createHost(state);
		(host as { magicKeywordEnabled: (k: string) => boolean }).magicKeywordEnabled = k => k === "ultrathink";
		const controls = makeControls(host);

		// 1. Normal message seeds the cache.
		await controls.applyAutoThinkingLevel("first normal message", 1);
		expect(classify).toHaveBeenCalledTimes(1);

		// 2. ultrathink sets #autoResolvedLevel to Max and must invalidate the key.
		await controls.applyAutoThinkingLevel("ultrathink go deep on this", 1);
		expect(classify).toHaveBeenCalledTimes(1);

		// 3. The next normal message must NOT inherit Max — classify fresh.
		await controls.applyAutoThinkingLevel("back to normal", 1);
		expect(classify).toHaveBeenCalledTimes(2);
	});
});
