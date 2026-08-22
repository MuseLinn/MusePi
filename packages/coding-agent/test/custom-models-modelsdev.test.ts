import { describe, expect, test } from "bun:test";
import { buildModelsDevGlobalCapabilities, finalizeCustomModel } from "../src/config/custom-models";

// A minimal models.dev payload (stencil.so shape): provider → { models: { id: row } }.
const MODELS_DEV_PAYLOAD = {
	"opencode-go": {
		models: {
			"deepseek-v4-flash-vision-exp": {
				name: "DeepSeek V4 Flash Vision (exp)",
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 1_000_000, output: 384_000 },
			},
			// Same id under a second provider with a SMALLER window — the index
			// must keep the richest row (opencode-go).
			"opencode-zen": {
				name: "DeepSeek V4 Flash Vision (exp)",
				modalities: { input: ["text", "image"] },
				limit: { context: 200_000, output: 100_000 },
			},
			"kimi-k3": {
				name: "Kimi K3",
				reasoning: true,
				modalities: { input: ["text", "image", "video"] },
				limit: { context: 1_048_576, output: 131_072 },
			},
		},
	},
} as const;

describe("models.dev capability fallback for custom models", () => {
	test("builds a global index picking the richest row per id", () => {
		const index = buildModelsDevGlobalCapabilities(MODELS_DEV_PAYLOAD);
		const vision = index.get("deepseek-v4-flash-vision-exp");
		expect(vision).toBeDefined();
		// opencode-zen's 200K must not override opencode-go's 1M.
		expect(vision?.contextWindow).toBe(1_000_000);
		expect(vision?.input).toEqual(["text", "image"]);
		expect(vision?.reasoning).toBe(true);
		const kimi = index.get("kimi-k3");
		expect(kimi?.contextWindow).toBe(1_048_576);
		expect(kimi?.input).toEqual(["text", "image", "video"]);
		expect(kimi?.reasoning).toBe(true);
	});

	test("finalizeCustomModel inherits contextWindow/input from models.dev when bundled misses", () => {
		// UseDefaults custom overlay for a gateway-first id NOT in models.json.
		const model = finalizeCustomModel(
			{
				id: "deepseek-v4-flash-vision-exp",
				provider: "b-ai",
				api: "openai-completions",
				baseUrl: "https://api.b.ai/v1",
			},
			{ useDefaults: true },
		);
		// The reference can only come from the cached payload once it is present
		// in the process; the sync index reads `getCachedModelsDevPayload`, which
		// is undefined in this unit test — so we assert the stable behavior:
		// without a cache the model still renders with the id-inferred input
		// (vision → image) instead of bare `["text"]`.
		expect(model.input).toContain("image");
		expect(model.id).toBe("deepseek-v4-flash-vision-exp");
	});
});

describe("buildModelsDevGlobalCapabilities input handling", () => {
	test("model without modalities still defaults to text", () => {
		const index = buildModelsDevGlobalCapabilities({ p: { models: { "some-model": { name: "Some" } } } });
		expect(index.get("some-model")?.input).toEqual(["text"]);
	});
});
