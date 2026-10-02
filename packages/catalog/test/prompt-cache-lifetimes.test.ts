import { describe, expect, test } from "bun:test";
import type { GeneratedProvider } from "@musepi/pi-catalog/models";
import { getBundledModels, getBundledProviders } from "@musepi/pi-catalog/models";

// The prompt-cache warmer only arms for a model whose catalog row declares an
// entry lifetime for the retention tier a request used — an unannotated model
// is skipped rather than guessed at. That makes the annotation a contract, not
// cosmetic metadata: if a catalog regen drops it, cache warming silently stops
// for every affected provider.
//
// Direct Anthropic is the only annotated provider (5m short / 1h long, per
// Anthropic's documented defaults). Bedrock, gateways, and openai-compat
// proxies deliberately stay unannotated: their replay behavior and expiry are
// unvalidated, and a wrong lifetime would over-warm or miss entries.
describe("bundled prompt-cache lifetimes", () => {
	const providers = getBundledProviders() as readonly GeneratedProvider[];

	test("every direct-Anthropic row declares both retention tiers", () => {
		const direct = getBundledModels("anthropic" as GeneratedProvider);
		expect(direct.length).toBeGreaterThan(0);
		expect(direct.every(model => model.api === "anthropic-messages")).toBe(true);
		for (const model of direct) {
			expect(model.promptCache).toEqual({ short: 300, long: 3600 });
		}
	});

	test("no other provider claims a prompt-cache lifetime", () => {
		const annotatedElsewhere = providers
			.filter(provider => provider !== "anthropic")
			.flatMap(provider => getBundledModels(provider))
			.filter(model => model.promptCache !== undefined)
			.map(model => `${model.provider}/${model.id}`);
		expect(annotatedElsewhere).toEqual([]);
	});

	test("an unannotated provider stays unannotated rather than defaulting to a lifetime", () => {
		// Absent must stay `undefined`, not 0: the warmer treats a missing tier
		// as "unknown lifetime, do not schedule" and 0 would read as expired.
		const sample = providers
			.filter(provider => provider !== "anthropic")
			.flatMap(provider => getBundledModels(provider));
		expect(sample.length).toBeGreaterThan(0);
		expect(sample.every(model => model.promptCache === undefined)).toBe(true);
	});
});
