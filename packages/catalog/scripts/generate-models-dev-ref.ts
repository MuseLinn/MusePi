#!/usr/bin/env bun

import bundled from "../src/models.json" with { type: "json" };
/**
 * Regenerate `src/models-dev-ref.json`: the offline, id-keyed capability table
 * for models that stencil.so (models.dev) declares but the bundled
 * `models.json` does not ship. `getBundledModelsDevCapabilities()` uses it when
 * the live catalog has not landed yet or the process is offline, so custom
 * provider model ids still inherit context window, reasoning, and modalities.
 *
 * Run after `gen:models`: the gap is computed from the current bundle. Each id
 * keeps the row with the largest context window (then the largest output cap)
 * so a provider-specific variant cannot shrink a model's declared capabilities.
 */
import { fetchWellKnownModels } from "../src/provider-models/openai-compat";

interface RawModel {
	name?: string;
	reasoning?: boolean;
	tool_call?: boolean;
	modalities?: { input?: string[] };
	limit?: { context?: number; output?: number };
}

interface RawProvider {
	models?: Record<string, RawModel>;
}

const bundledIds = new Set<string>();
for (const provider of Object.values(bundled as Record<string, Record<string, unknown>>)) {
	for (const id of Object.keys(provider)) bundledIds.add(id);
}

const data = (await fetchWellKnownModels()) as Record<string, RawProvider>;
const best = new Map<string, RawModel>();
for (const provider of Object.values(data ?? {})) {
	for (const [id, model] of Object.entries(provider.models ?? {})) {
		if (model?.tool_call !== true || bundledIds.has(id)) continue;
		const previous = best.get(id);
		const context = Number(model.limit?.context ?? 0);
		const output = Number(model.limit?.output ?? 0);
		const previousContext = Number(previous?.limit?.context ?? 0);
		const previousOutput = Number(previous?.limit?.output ?? 0);
		if (!previous || context > previousContext || (context === previousContext && output > previousOutput)) {
			best.set(id, model);
		}
	}
}

const reference: Record<
	string,
	{ name: string; reasoning: boolean; context?: number; input?: string[]; output?: number }
> = {};
for (const id of [...best.keys()].sort()) {
	const model = best.get(id);
	if (!model) continue;
	reference[id] = {
		name: model.name || id,
		reasoning: model.reasoning === true,
		context: model.limit?.context,
		input: model.modalities?.input,
		output: model.limit?.output,
	};
}

await Bun.write(`${import.meta.dir}/../src/models-dev-ref.json`, `${JSON.stringify(reference, null, "\t")}\n`);
console.log(`Generated src/models-dev-ref.json (${Object.keys(reference).length} models)`);
