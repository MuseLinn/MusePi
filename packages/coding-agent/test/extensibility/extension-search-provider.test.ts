import { afterEach, describe, expect, it } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { loadExtensionFromFactory } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionAPI, ExtensionRuntime } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { resolveProviderCandidates } from "@musepi/pi-coding-agent/web/search/provider";
import type { SearchProvider } from "@musepi/pi-coding-agent/web/search/providers/base";
import { getRegisteredSearchProvider, releaseSearchProviders } from "@musepi/pi-coding-agent/web/search/registry";
import { asDynamicSearchProviderId, type SearchResponse } from "@musepi/pi-coding-agent/web/search/types";

const EXTENSION = "search-provider-test-extension";
const OTHER_EXTENSION = "search-provider-test-other";
const PROVIDER_ID = "plugin-search";

function stubProvider(): SearchProvider {
	return {
		id: asDynamicSearchProviderId(PROVIDER_ID),
		label: "Plugin Search",
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: async (): Promise<SearchResponse> => ({
			provider: asDynamicSearchProviderId(PROVIDER_ID),
			sources: [],
		}),
	};
}

async function loadPlugin(factory: (pi: ExtensionAPI) => void, name = EXTENSION) {
	const eventBus = new Context() as never;
	const runtime = {
		eventBus,
		pendingProviderRegistrations: [],
		pendingMediaProviderRegistrations: [],
		pendingDesignSystemRegistrations: [],
	} as unknown as ExtensionRuntime;
	return loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime, name);
}

afterEach(() => {
	releaseSearchProviders(EXTENSION);
	releaseSearchProviders(OTHER_EXTENSION);
});

describe("ExtensionAPI.registerSearchProvider", () => {
	it("registers a plugin provider that joins the search chain and releases with its extension", async () => {
		const extension = await loadPlugin(pi => {
			expect(pi.registerSearchProvider({ id: PROVIDER_ID, label: "Plugin Search", factory: stubProvider })).toEqual({
				id: PROVIDER_ID,
			});
			// Built-ins are shipped providers, not extension-owned registrations.
			expect(pi.unregisterSearchProvider("deepseek")).toBe(false);
		});

		expect(getRegisteredSearchProvider(PROVIDER_ID)).toMatchObject({ label: "Plugin Search", builtin: false });
		expect(resolveProviderCandidates().at(-1)?.id).toBe(asDynamicSearchProviderId(PROVIDER_ID));

		expect(releaseSearchProviders(EXTENSION, extension)).toEqual([PROVIDER_ID]);
		expect(getRegisteredSearchProvider(PROVIDER_ID)).toBeUndefined();
		expect(resolveProviderCandidates().map(candidate => candidate.id)).not.toContain(PROVIDER_ID);
	});

	it("rejects another extension's id and only removes what it owns", async () => {
		let ownerApi: ExtensionAPI | undefined;
		let otherApi: ExtensionAPI | undefined;
		await loadPlugin(pi => {
			ownerApi = pi;
			pi.registerSearchProvider({ id: PROVIDER_ID, label: "Plugin Search", factory: stubProvider });
		});
		await loadPlugin(pi => {
			otherApi = pi;
		}, OTHER_EXTENSION);

		expect(() =>
			otherApi?.registerSearchProvider({ id: PROVIDER_ID, label: "Hijack", factory: stubProvider }),
		).toThrow(/already registered by another owner/);
		expect(otherApi?.unregisterSearchProvider(PROVIDER_ID)).toBe(false);
		expect(getRegisteredSearchProvider(PROVIDER_ID)?.label).toBe("Plugin Search");

		expect(ownerApi?.unregisterSearchProvider(PROVIDER_ID)).toBe(true);
		expect(getRegisteredSearchProvider(PROVIDER_ID)).toBeUndefined();
	});
});
