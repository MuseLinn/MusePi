import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@musepi/pi-ai";
import { SelectorController } from "@musepi/pi-coding-agent/modes/controllers/selector-controller";
import {
	isConnectionLevelSearchError,
	recordSearchProviderConnectivityFailure,
	resetSearchProviderConnectivity,
	resolveProviderCandidates,
	resolveProviderChain,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@musepi/pi-coding-agent/web/search/provider";
import { SEARCH_PROVIDER_ORDER } from "@musepi/pi-coding-agent/web/search/types";

const authStorage = {
	hasAuth(provider: string): boolean {
		return provider === "jina" && Boolean(process.env.JINA_API_KEY);
	},
} as AuthStorage;
const originalBraveApiKey = process.env.BRAVE_API_KEY;
const originalJinaApiKey = process.env.JINA_API_KEY;

function enableKeyBackedProviders(): void {
	process.env.BRAVE_API_KEY = "test-brave-key";
	process.env.JINA_API_KEY = "test-jina-key";
}

function restoreEnv(): void {
	if (originalBraveApiKey === undefined) {
		delete process.env.BRAVE_API_KEY;
	} else {
		process.env.BRAVE_API_KEY = originalBraveApiKey;
	}

	if (originalJinaApiKey === undefined) {
		delete process.env.JINA_API_KEY;
	} else {
		process.env.JINA_API_KEY = originalJinaApiKey;
	}
}

afterEach(() => {
	setExcludedSearchProviders([]);
	setSearchProviderOrder([]);
	resetSearchProviderConnectivity();
	vi.restoreAllMocks();
	restoreEnv();
});

describe("resolveProviderCandidates", () => {
	it("orders the forced provider before configured and built-in fallbacks", () => {
		setSearchProviderOrder(["gemini", "exa"]);

		const candidates = resolveProviderCandidates("perplexity");

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates.slice(1).map(candidate => candidate.id)).toEqual([
			"gemini",
			"exa",
			...SEARCH_PROVIDER_ORDER.filter(id => id !== "perplexity" && id !== "gemini" && id !== "exa"),
		]);
	});

	it("marks configured-order entries explicit so hand-listed providers keep explicit-selection semantics", () => {
		setSearchProviderOrder(["perplexity"]);

		const candidates = resolveProviderCandidates();

		expect(candidates[0]).toEqual({ id: "perplexity", explicit: true });
		expect(candidates[1]?.explicit).toBe(false);
	});

	it("omits excluded providers without resolving them", () => {
		setExcludedSearchProviders(["duckduckgo", "google"]);

		const candidates = resolveProviderCandidates("exa");

		expect(candidates.map(candidate => candidate.id)).not.toContain("duckduckgo");
		expect(candidates.map(candidate => candidate.id)).not.toContain("google");
	});

	it("applies live settings edits, filtering invalid and duplicate provider IDs", () => {
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange("providers.webSearchOrder", ["exa", "not-a-provider", "exa", "gemini"]);

		const candidates = resolveProviderCandidates();
		expect(candidates.slice(0, 2).map(candidate => candidate.id)).toEqual(["exa", "gemini"]);
		expect(candidates).toHaveLength(SEARCH_PROVIDER_ORDER.length);
	});

	it("skips auto-chain providers that recently failed at the connection level", () => {
		recordSearchProviderConnectivityFailure("duckduckgo");

		const candidates = resolveProviderCandidates();

		expect(candidates.map(candidate => candidate.id)).not.toContain("duckduckgo");
		expect(candidates).toHaveLength(SEARCH_PROVIDER_ORDER.length - 1);
	});

	it("keeps explicitly ordered providers despite a recorded connection-level failure", () => {
		setSearchProviderOrder(["duckduckgo"]);
		recordSearchProviderConnectivityFailure("duckduckgo");

		const candidates = resolveProviderCandidates();

		expect(candidates[0]).toEqual({ id: "duckduckgo", explicit: true });
	});

	it("still tries a forced provider despite a recorded connection-level failure", () => {
		recordSearchProviderConnectivityFailure("exa");

		const candidates = resolveProviderCandidates("exa");

		expect(candidates[0]).toEqual({ id: "exa", explicit: true });
	});

	it("re-admits a provider once the connectivity failure outlives its retry window", () => {
		recordSearchProviderConnectivityFailure("duckduckgo");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);

		const candidates = resolveProviderCandidates();

		expect(candidates.map(candidate => candidate.id)).toContain("duckduckgo");
	});
});

describe("isConnectionLevelSearchError", () => {
	it("matches transport failures, including ones nested as error causes", () => {
		expect(
			isConnectionLevelSearchError(new Error("Unable to connect. Is the computer able to access the url?")),
		).toBe(true);
		expect(isConnectionLevelSearchError(new Error("fetch failed"))).toBe(true);
		expect(isConnectionLevelSearchError(new Error("request failed", { cause: new Error("connect ETIMEDOUT") }))).toBe(
			true,
		);
	});

	it("rejects HTTP-status and bot-challenge failures — the endpoint was reached", () => {
		expect(
			isConnectionLevelSearchError(new Error("DuckDuckGo blocked the request with a bot-detection challenge")),
		).toBe(false);
		expect(isConnectionLevelSearchError(new Error("Brave API error (401): unauthorized"))).toBe(false);
	});
});

describe("resolveProviderChain", () => {
	it("omits excluded providers from the fallback chain", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("ignores the forced provider when it is excluded", async () => {
		enableKeyBackedProviders();
		setExcludedSearchProviders(SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"));

		const providers = await resolveProviderChain(authStorage, "brave");

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});

	it("applies live settings edits to the exclusion chain", async () => {
		enableKeyBackedProviders();
		const controller = new SelectorController({} as unknown as ConstructorParameters<typeof SelectorController>[0]);

		controller.handleSettingChange(
			"providers.webSearchExclude",
			SEARCH_PROVIDER_ORDER.filter(id => id !== "jina"),
		);

		const providers = await resolveProviderChain(authStorage);

		expect(providers.map(provider => provider.id)).toEqual(["jina"]);
	});
});
