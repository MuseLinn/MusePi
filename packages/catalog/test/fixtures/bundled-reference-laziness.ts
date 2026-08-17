import { expect, spyOn } from "bun:test";
import * as buildModule from "../../src/build";
import type { GeneratedProvider } from "../../src/models";
import { ollamaCloudModelManagerOptions } from "../../src/provider-models/ollama";
import { nanoGptModelManagerOptions } from "../../src/provider-models/openai-compat";

Bun.gc(true);
const rssBefore = process.memoryUsage().rss;
nanoGptModelManagerOptions();
ollamaCloudModelManagerOptions();
Bun.gc(true);
const retainedRssBytes = process.memoryUsage().rss - rssBefore;

process.stdout.write(JSON.stringify({ retainedRssBytes }));

// Keep the model-registry import below the RSS assertion setup: importing it
// eagerly loads models.json and would invalidate the provider-option laziness
// measurement above. This same isolated process can then verify the registry's
// own lazy, per-provider enrichment without paying for a second Bun startup.
const { getBundledModel, getBundledModels, getBundledProviders } = await import("../../src/models");
const { default: MODELS } = await import("../../src/models.json", { with: { type: "json" } });
const buildSpy = spyOn(buildModule, "buildModel");
const rawProviders = Object.keys(MODELS);
const firstProviders = getBundledProviders();
const secondProviders = getBundledProviders();

expect(buildSpy).toHaveBeenCalledTimes(0);
expect(firstProviders as string[]).toEqual(rawProviders);
expect(secondProviders as string[]).toEqual(rawProviders);
expect(secondProviders).not.toBe(firstProviders);

const provider = "sakana" satisfies GeneratedProvider;
const rawModelIds = Object.keys(MODELS[provider]);
const firstModels = getBundledModels(provider);

expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);
expect(firstModels.map(model => model.id)).toEqual(rawModelIds);

const secondModels = getBundledModels(provider);
expect(secondModels).not.toBe(firstModels);
expect(secondModels).toHaveLength(firstModels.length);
for (let index = 0; index < firstModels.length; index++) {
	expect(secondModels[index]).toBe(firstModels[index]);
}
expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);

const firstModelId = rawModelIds[0];
if (firstModelId === undefined) throw new Error(`${provider} must have a bundled model`);
expect(getBundledModel(provider, firstModelId)).toBe(firstModels[0]);
expect(getBundledModel(provider, firstModelId)).toBe(firstModels[0]);
expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);

const unknownProvider = "not-a-bundled-provider" as GeneratedProvider;
expect(getBundledModels(unknownProvider)).toEqual([]);
expect(getBundledModel(unknownProvider, "missing-model")).toBeUndefined();
expect(buildSpy).toHaveBeenCalledTimes(rawModelIds.length);

buildSpy.mockRestore();
