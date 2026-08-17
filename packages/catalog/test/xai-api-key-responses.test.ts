import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@musepi/pi-catalog/model-manager";
import { getBundledModels } from "@musepi/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@musepi/pi-catalog/provider-models/descriptors";
import { xaiModelManagerOptions } from "@musepi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@musepi/pi-catalog/types";

const XAI_RESPONSES_SPEC: ModelSpec<"openai-responses"> = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: "openai-responses",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 500_000,
	maxTokens: 500_000,
};
const XAI_COMPLETIONS_SPEC: ModelSpec<"openai-completions"> = {
	id: "grok-4.5",
	name: "Grok 4.5",
	api: "openai-completions",
	provider: "xai",
	baseUrl: "https://api.x.ai/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
	contextWindow: 500_000,
	maxTokens: 500_000,
};

describe("paid xai (XAI_API_KEY) Responses contract", () => {
	it("registers xai on the catalog Responses discovery path", () => {
		const entry = CATALOG_PROVIDERS.find(provider => provider.id === "xai");
		expect(entry, "xai catalog descriptor").toBeDefined();
		expect(entry!.defaultModel).toBe("grok-4.5");
		expect(entry!.envVars).toContain("XAI_API_KEY");
		const options = xaiModelManagerOptions({ apiKey: "test-key" });
		expect(options.providerId).toBe("xai");
		expect(options.fetchDynamicModels, "live /v1/models overlay").toBeTypeOf("function");
		expect(options.dropCachedModelIdsOnStaticMismatch).toEqual(getBundledModels("xai").map(model => model.id));
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("grok-4.5");
	});

	it("bundles every paid xai chat model on openai-responses", () => {
		const models = getBundledModels("xai");
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(model.api, `${model.provider}/${model.id}`).toBe("openai-responses");
			expect(model.baseUrl).toBe("https://api.x.ai/v1");
		}
	});

	it("drops stale Chat Completions cache rows so Responses takes effect immediately", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-xai-completions-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		try {
			await resolveProviderModels(
				{
					providerId: "xai",
					staticModels: [XAI_COMPLETIONS_SPEC],
					fetchDynamicModels: async () => [XAI_COMPLETIONS_SPEC],
					cacheDbPath: dbPath,
				},
				"online",
			);

			let fetches = 0;
			const migrated = await resolveProviderModels(
				{
					...xaiModelManagerOptions(),
					staticModels: [XAI_RESPONSES_SPEC],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => {
						fetches += 1;
						return [XAI_RESPONSES_SPEC];
					},
				},
				"online-if-uncached",
			);

			expect(fetches).toBe(1);
			expect(migrated.models.find(model => model.id === "grok-4.5")?.api).toBe("openai-responses");

			const offline = await resolveProviderModels(
				{
					...xaiModelManagerOptions(),
					staticModels: [XAI_RESPONSES_SPEC],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => null,
				},
				"offline",
			);
			expect(offline.models.find(model => model.id === "grok-4.5")?.api).toBe("openai-responses");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
