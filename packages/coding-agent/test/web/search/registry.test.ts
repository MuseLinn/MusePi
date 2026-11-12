import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@musepi/pi-ai";
import { runSearchQuery } from "@musepi/pi-coding-agent/web/search";
import {
	getSearchProvider,
	resolveProviderCandidates,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@musepi/pi-coding-agent/web/search/provider";
import type { SearchProvider } from "@musepi/pi-coding-agent/web/search/providers/base";
import {
	getRegisteredSearchProvider,
	listRegisteredSearchProviders,
	registerSearchProvider,
	releaseSearchProviders,
	unregisterSearchProvider,
} from "@musepi/pi-coding-agent/web/search/registry";
import {
	asDynamicSearchProviderId,
	SEARCH_PROVIDER_LABELS,
	SEARCH_PROVIDER_ORDER,
	type SearchResponse,
	type SearchSource,
} from "@musepi/pi-coding-agent/web/search/types";

const OWNER = "test-extension";

let nextId = 0;
const registered: string[] = [];

function uniqueId(): string {
	nextId += 1;
	return `test-search-${nextId}`;
}

function stubProvider(id: string, sources: SearchSource[] = []): SearchProvider {
	return {
		id: asDynamicSearchProviderId(id),
		label: `Stub ${id}`,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		search: async (): Promise<SearchResponse> => ({
			provider: asDynamicSearchProviderId(id),
			sources,
		}),
	};
}

function registerStub(
	id: string,
	options: { owner?: string; generation?: object; availability?: () => boolean } = {},
): void {
	registerSearchProvider(
		{
			id,
			label: `Stub ${id}`,
			...(options.availability ? { availability: options.availability } : {}),
			factory: () => stubProvider(id),
		},
		{ owner: options.owner ?? OWNER, ...(options.generation ? { generation: options.generation } : {}) },
	);
	registered.push(id);
}

afterEach(() => {
	for (const id of registered.splice(0)) unregisterSearchProvider(id, { owner: OWNER });
	releaseSearchProviders(OWNER);
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
});

describe("search provider registry", () => {
	it("lists every built-in option from the same table that resolves them", () => {
		const builtins = listRegisteredSearchProviders().filter(provider => provider.builtin);

		expect(builtins.map(provider => provider.id)).toEqual([...SEARCH_PROVIDER_ORDER]);
		for (const provider of builtins) {
			expect(provider.label).toBe(SEARCH_PROVIDER_LABELS[provider.id as keyof typeof SEARCH_PROVIDER_LABELS]);
		}
	});

	it("registers a runtime provider and removes it on unregister", () => {
		const id = uniqueId();
		registerStub(id);

		expect(getRegisteredSearchProvider(id)).toMatchObject({ id, builtin: false });
		expect(listRegisteredSearchProviders().map(provider => provider.id)).toContain(id);
		expect(unregisterSearchProvider(id, { owner: OWNER })).toBe(true);
		expect(getRegisteredSearchProvider(id)).toBeUndefined();
		expect(unregisterSearchProvider(id, { owner: OWNER })).toBe(false);
	});

	it("rejects blank, reserved, and colliding ids instead of overwriting", () => {
		expect(() => registerSearchProvider({ id: "  ", label: "x", factory: () => stubProvider("x") })).toThrow(
			/non-empty provider id/,
		);
		expect(() => registerSearchProvider({ id: "auto", label: "x", factory: () => stubProvider("x") })).toThrow(
			/reserved id/,
		);
		expect(() => registerSearchProvider({ id: "deepseek", label: "x", factory: () => stubProvider("x") })).toThrow(
			/conflicts with a built-in/,
		);

		const id = uniqueId();
		registerStub(id);
		expect(() =>
			registerSearchProvider({ id, label: "other", factory: () => stubProvider(id) }, { owner: "another-owner" }),
		).toThrow(/already registered by another owner/);
		expect(getRegisteredSearchProvider(id)?.label).toBe(`Stub ${id}`);
	});

	it("lets one owner replace its own registration and drops the cached instance", async () => {
		const id = uniqueId();
		registerStub(id);
		const first = await getSearchProvider(asDynamicSearchProviderId(id));
		expect(await getSearchProvider(asDynamicSearchProviderId(id))).toBe(first);

		let built = 0;
		const replacement: SearchProvider = Object.assign(stubProvider(id), { label: "Replacement" });
		registerSearchProvider(
			{
				id,
				label: "Replacement",
				factory: () => {
					built += 1;
					return replacement;
				},
			},
			{ owner: OWNER },
		);

		expect(getRegisteredSearchProvider(id)?.label).toBe("Replacement");
		expect(await getSearchProvider(asDynamicSearchProviderId(id))).toBe(replacement);
		expect(built).toBe(1);
	});

	it("appends runtime providers after the built-in chain and honors user order and exclusion", () => {
		const id = uniqueId();
		registerStub(id);

		const automatic = resolveProviderCandidates();
		expect(automatic).toHaveLength(SEARCH_PROVIDER_ORDER.length + 1);
		expect(automatic.at(-1)).toEqual({ id: asDynamicSearchProviderId(id), explicit: false });

		setSearchProviderOrder([asDynamicSearchProviderId(id)]);
		const prioritized = resolveProviderCandidates();
		expect(prioritized[0]).toEqual({ id: asDynamicSearchProviderId(id), explicit: true });
		expect(prioritized).toHaveLength(SEARCH_PROVIDER_ORDER.length + 1);

		setExcludedSearchProviders([asDynamicSearchProviderId(id)]);
		expect(resolveProviderCandidates().map(candidate => candidate.id)).not.toContain(id);
	});

	it("selects a runtime provider explicitly, even when its availability gate is closed", () => {
		const id = uniqueId();
		registerStub(id, { availability: () => false });

		expect(resolveProviderCandidates().map(candidate => candidate.id)).not.toContain(id);
		expect(resolveProviderCandidates(asDynamicSearchProviderId(id))[0]).toEqual({
			id: asDynamicSearchProviderId(id),
			explicit: true,
		});
	});

	it("runs a runtime provider selected explicitly through the search tool", async () => {
		const id = uniqueId();
		let seenQuery: string | undefined;
		registerSearchProvider(
			{
				id,
				label: "Plugin Search",
				factory: () =>
					Object.assign(stubProvider(id), {
						search: async (params: Parameters<SearchProvider["search"]>[0]) => {
							seenQuery = params.query;
							return {
								provider: asDynamicSearchProviderId(id),
								sources: [{ title: "Plugin result", url: "https://example.com/plugin" }],
							};
						},
					}),
			},
			{ owner: OWNER },
		);
		registered.push(id);

		const result = await runSearchQuery(
			{ query: "plugin query", provider: asDynamicSearchProviderId(id) },
			{ authStorage: {} as AuthStorage },
		);

		expect(seenQuery).toBe("plugin query");
		expect(result.content[0]?.text).toContain("https://example.com/plugin");
	});

	it("releases one owner generation without touching a reloaded replacement", () => {
		const id = uniqueId();
		const oldGeneration = {};
		const newGeneration = {};
		registerStub(id, { generation: oldGeneration });
		registerSearchProvider(
			{ id, label: "Reloaded", factory: () => stubProvider(id) },
			{ owner: OWNER, generation: newGeneration },
		);

		expect(releaseSearchProviders(OWNER, oldGeneration)).toEqual([]);
		expect(getRegisteredSearchProvider(id)?.label).toBe("Reloaded");
		expect(releaseSearchProviders(OWNER, newGeneration)).toEqual([id]);
		expect(getRegisteredSearchProvider(id)).toBeUndefined();
	});
});
