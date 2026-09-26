/**
 * Connectivity-level failover: providers that fail before any HTTP exchange
 * (the classic proxyless mainland-China case, where every overseas keyless
 * engine is unreachable) are remembered and skipped by the auto chain, and
 * the all-failed message points at the working remedies instead of leaving a
 * bare "Unable to connect" dump.
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
		label: id,
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

describe("executeSearch connectivity failover", () => {
	it("appends actionable guidance when every provider failed before any HTTP exchange", async () => {
		mockProviderChain([
			fakeProvider("duckduckgo", async () => {
				throw new Error("Unable to connect. Is the computer able to access the url?");
			}),
			fakeProvider("bing", async () => {
				throw new Error("fetch failed");
			}),
		]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });

		const block = result.content[0];
		const text = block?.type === "text" ? block.text : "";
		expect(text).toContain("All web search providers failed");
		expect(text).toContain("HTTPS_PROXY");
		expect(text).toContain("providers.webSearchOrder");
		expect(result.details?.error).toContain("HTTPS_PROXY");
	});

	it("does not append connectivity guidance when a failure reached HTTP", async () => {
		mockProviderChain([
			fakeProvider("duckduckgo", async () => {
				throw new SearchProviderError("duckduckgo", "bot-detection challenge", 429);
			}),
		]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });

		const block = result.content[0];
		const text = block?.type === "text" ? block.text : "";
		expect(text).not.toContain("HTTPS_PROXY");
	});

	it("records connection-level failures so the real auto chain skips the provider afterwards", async () => {
		mockProviderChain([
			fakeProvider("duckduckgo", async () => {
				throw new Error("Unable to connect. Is the computer able to access the url?");
			}),
		]);

		await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });
		vi.restoreAllMocks();

		const candidates = provider.resolveProviderCandidates();
		expect(candidates.map(candidate => candidate.id)).not.toContain("duckduckgo");
	});

	it("clears the recorded failure after a successful search", async () => {
		provider.recordSearchProviderConnectivityFailure("duckduckgo");
		mockProviderChain([
			fakeProvider("duckduckgo", async () => ({
				provider: "duckduckgo",
				sources: [{ title: "Recovered result", url: "https://example.com/recovered" }],
			})),
		]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });
		vi.restoreAllMocks();

		expect(result.details?.response.provider).toBe("duckduckgo");
		expect(provider.resolveProviderCandidates().map(candidate => candidate.id)).toContain("duckduckgo");
	});

	it("does not record HTTP-status failures as connectivity outages", async () => {
		mockProviderChain([
			fakeProvider("duckduckgo", async () => {
				throw new SearchProviderError("duckduckgo", "bot-detection challenge", 429);
			}),
		]);

		await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });
		vi.restoreAllMocks();

		expect(provider.resolveProviderCandidates().map(candidate => candidate.id)).toContain("duckduckgo");
	});
});
