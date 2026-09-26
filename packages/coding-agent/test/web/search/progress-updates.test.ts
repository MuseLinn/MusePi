/**
 * Mid-chain progress streaming + provider display labels: while the auto
 * chain walks providers, each attempt emits a tool update naming the provider
 * being tried and the ones that already failed (the GUI/TUI show live
 * progress instead of a silent spinner), and terminal details carry the
 * provider's display label so clients never render the raw config id.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { WebSearchTool } from "@musepi/pi-coding-agent/web/search";
import * as provider from "@musepi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@musepi/pi-coding-agent/web/search/providers/base";
import {
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
} from "@musepi/pi-coding-agent/web/search/types";

const FAKE_SESSION = {} as ToolSession;

function fakeProvider(id: SearchProviderId, behaviour: (params: SearchParams) => Promise<SearchResponse>) {
	return {
		id,
		// Deliberately distinct from the id: label assertions would pass
		// vacuously if the two were the same string.
		label: id.toUpperCase(),
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: behaviour,
	};
}

function mockProviderChain(providers: ReturnType<typeof fakeProvider>[]) {
	vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue(
		providers.map(({ id }) => ({ id, explicit: false })),
	);
	return vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
		const match = providers.find(candidate => candidate.id === id);
		if (!match) throw new Error(`Unexpected provider: ${id}`);
		return match as provider.SearchProvider;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	provider.resetSearchProviderConnectivity();
});

describe("executeSearch progress updates", () => {
	it("streams the provider being tried and the ones that already failed", async () => {
		mockProviderChain([
			fakeProvider("duckduckgo", async () => {
				throw new SearchProviderError("duckduckgo", "bot-detection challenge", 429);
			}),
			fakeProvider("bing", async () => ({
				provider: "bing",
				sources: [{ title: "Result", url: "https://example.com/r" }],
			})),
		]);

		const updates: Array<{ current?: string; failed?: string[] }> = [];
		const result = await new WebSearchTool(FAKE_SESSION).execute(
			"test-id",
			{ query: "anything" },
			undefined,
			partial => {
				updates.push({
					current: partial.details?.progress?.current,
					failed: partial.details?.progress?.failed,
				});
			},
		);

		expect(updates).toEqual([
			{ current: "DUCKDUCKGO", failed: [] },
			{ current: "BING", failed: ["DUCKDUCKGO"] },
		]);
		expect(result.details?.response.provider).toBe("bing");
	});

	it("carries the provider display label on success and on failure", async () => {
		mockProviderChain([
			fakeProvider("mojeek", async () => ({
				provider: "mojeek",
				sources: [{ title: "Result", url: "https://example.com/r" }],
			})),
		]);
		const success = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });
		expect(success.details?.providerLabel).toBe("MOJEEK");

		vi.restoreAllMocks();
		mockProviderChain([
			fakeProvider("mojeek", async () => {
				throw new SearchProviderError("mojeek", "upstream exploded", 500);
			}),
		]);
		const failure = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });
		expect(failure.details?.providerLabel).toBe("MOJEEK");
		expect(failure.details?.error).toContain("upstream exploded");
	});
});
