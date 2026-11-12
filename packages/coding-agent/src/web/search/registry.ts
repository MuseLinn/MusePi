/**
 * Web search provider registry.
 *
 * The single list of search providers: built-ins register here at module load
 * (each `factory` dynamic-imports its implementation on first use, so importing
 * this module loads zero provider code) and extensions append their own
 * descriptors at runtime. `provider.ts` reads this registry instead of keeping a
 * second table, so labels, ids, and instance caching have one owner.
 *
 * Ownership rules:
 *
 * - The descriptor id must be non-empty, must not be the `auto`/`none`
 *   sentinels, and must not collide with a built-in or another owner's
 *   registration; a collision throws instead of overwriting.
 * - Re-registering an id this owner already registered replaces it, so an
 *   extension hot reload may re-run its factory without fighting itself.
 * - Registration is process-wide but owner-tracked: the extension runner
 *   releases what one extension still owns on unload and session shutdown.
 */

import type { SearchProvider } from "./providers/base";
import {
	type AnySearchProviderId,
	asDynamicSearchProviderId,
	SEARCH_PROVIDER_LABELS,
	SEARCH_PROVIDER_ORDER,
	type SearchProviderId,
} from "./types";

/** How a provider enters the registry. */
export interface SearchProviderDescriptor {
	/** Provider id. Non-empty, unique across built-ins and registered providers. */
	readonly id: string;
	/** User-facing label. */
	readonly label: string;
	/**
	 * Cheap synchronous admission check. `false` removes the provider from the
	 * automatic chain and from listings; an explicit selection still tries it.
	 * Credential checks that need {@link AuthStorage} belong in
	 * `SearchProvider.isAvailable`, not here.
	 */
	readonly availability?: () => boolean;
	/** Builds the provider instance. Called once per registration, then cached. */
	readonly factory: () => SearchProvider | Promise<SearchProvider>;
}

/** A descriptor as stored, with its provenance. */
export interface RegisteredSearchProvider extends SearchProviderDescriptor {
	/** Built-ins ship with the agent and can never be unregistered. */
	readonly builtin: boolean;
}

export interface SearchProviderRegistrationOptions {
	/** Stable owner label (the extension path) used for conflict messages and release. */
	owner?: string;
	/** Opaque owner-generation identity (the extension record) so a reload releases only its predecessor. */
	generation?: object;
}

interface RegisteredEntry extends RegisteredSearchProvider {
	readonly owner?: string;
	readonly generation?: object;
}

interface BuiltinDefinition {
	readonly label: string;
	readonly factory: () => Promise<SearchProvider>;
}

/**
 * Lazy built-in factories, keyed by the closed {@link SearchProviderId} union so
 * a new option in `SEARCH_PROVIDER_OPTIONS` cannot ship without a producer.
 * Each `factory()` dynamic-imports its provider module on first call.
 */
const BUILTIN_DEFINITIONS: Record<SearchProviderId, BuiltinDefinition> = {
	perplexity: {
		label: SEARCH_PROVIDER_LABELS.perplexity,
		factory: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	gemini: {
		label: SEARCH_PROVIDER_LABELS.gemini,
		factory: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	anthropic: {
		label: SEARCH_PROVIDER_LABELS.anthropic,
		factory: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	codex: {
		label: SEARCH_PROVIDER_LABELS.codex,
		factory: async () => new (await import("./providers/codex")).CodexProvider(),
	},
	xai: {
		label: SEARCH_PROVIDER_LABELS.xai,
		factory: async () => new (await import("./providers/xai")).XAIProvider(),
	},
	zai: {
		label: SEARCH_PROVIDER_LABELS.zai,
		factory: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
	exa: {
		label: SEARCH_PROVIDER_LABELS.exa,
		factory: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	tinyfish: {
		label: SEARCH_PROVIDER_LABELS.tinyfish,
		factory: async () => new (await import("./providers/tinyfish")).TinyFishProvider(),
	},
	jina: {
		label: SEARCH_PROVIDER_LABELS.jina,
		factory: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	kagi: {
		label: SEARCH_PROVIDER_LABELS.kagi,
		factory: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
	tavily: {
		label: SEARCH_PROVIDER_LABELS.tavily,
		factory: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	firecrawl: {
		label: SEARCH_PROVIDER_LABELS.firecrawl,
		factory: async () => new (await import("./providers/firecrawl")).FirecrawlProvider(),
	},
	brave: {
		label: SEARCH_PROVIDER_LABELS.brave,
		factory: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	kimi: {
		label: SEARCH_PROVIDER_LABELS.kimi,
		factory: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	parallel: {
		label: SEARCH_PROVIDER_LABELS.parallel,
		factory: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	synthetic: {
		label: SEARCH_PROVIDER_LABELS.synthetic,
		factory: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	searxng: {
		label: SEARCH_PROVIDER_LABELS.searxng,
		factory: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
	bochaai: {
		label: SEARCH_PROVIDER_LABELS.bochaai,
		factory: async () => new (await import("./providers/bochaai")).BochaaiProvider(),
	},
	deepseek: {
		label: SEARCH_PROVIDER_LABELS.deepseek,
		factory: async () => new (await import("./providers/deepseek")).DeepSeekProvider(),
	},
	duckduckgo: {
		label: SEARCH_PROVIDER_LABELS.duckduckgo,
		factory: async () => new (await import("./providers/duckduckgo")).DuckDuckGoProvider(),
	},
	bing: {
		label: SEARCH_PROVIDER_LABELS.bing,
		factory: async () => new (await import("./providers/bing")).BingProvider(),
	},
	google: {
		label: SEARCH_PROVIDER_LABELS.google,
		factory: async () => new (await import("./providers/google")).GoogleProvider(),
	},
	ecosia: {
		label: SEARCH_PROVIDER_LABELS.ecosia,
		factory: async () => new (await import("./providers/ecosia")).EcosiaProvider(),
	},
	startpage: {
		label: SEARCH_PROVIDER_LABELS.startpage,
		factory: async () => new (await import("./providers/startpage")).StartpageProvider(),
	},
	mojeek: {
		label: SEARCH_PROVIDER_LABELS.mojeek,
		factory: async () => new (await import("./providers/mojeek")).MojeekProvider(),
	},
	public: {
		label: SEARCH_PROVIDER_LABELS.public,
		factory: async () => new (await import("./providers/public")).PublicWebProvider(),
	},
};

/** Sentinel filter values that must never name a provider. */
const RESERVED_IDS = new Set(["auto", "none"]);

const registry = new Map<string, RegisteredEntry>();
const instances = new Map<string, SearchProvider>();

for (const id of SEARCH_PROVIDER_ORDER) {
	const definition = BUILTIN_DEFINITIONS[id];
	registry.set(id, { id, label: definition.label, factory: definition.factory, builtin: true });
}

function project(entry: RegisteredEntry): RegisteredSearchProvider {
	return {
		id: entry.id,
		label: entry.label,
		builtin: entry.builtin,
		...(entry.availability ? { availability: entry.availability } : {}),
		factory: entry.factory,
	};
}

/**
 * Register a runtime provider.
 *
 * Throws on a blank id/label, a non-function factory, a reserved id, or an id
 * owned by a built-in or another owner. Re-registering this owner's own id
 * replaces the descriptor and drops its cached instance (hot reload).
 */
export function registerSearchProvider(
	descriptor: SearchProviderDescriptor,
	options: SearchProviderRegistrationOptions = {},
): RegisteredSearchProvider {
	if (typeof descriptor !== "object" || descriptor === null) {
		throw new Error("registerSearchProvider requires a provider descriptor");
	}
	const id = typeof descriptor.id === "string" ? descriptor.id.trim() : "";
	if (id === "") throw new Error("registerSearchProvider requires a non-empty provider id");
	if (RESERVED_IDS.has(id)) throw new Error(`registerSearchProvider "${id}" is a reserved id`);
	const label = typeof descriptor.label === "string" ? descriptor.label.trim() : "";
	if (label === "") throw new Error(`registerSearchProvider "${id}" requires a non-empty label`);
	if (typeof descriptor.factory !== "function") {
		throw new Error(`registerSearchProvider "${id}" requires a factory function`);
	}
	if (descriptor.availability !== undefined && typeof descriptor.availability !== "function") {
		throw new Error(`registerSearchProvider "${id}" availability must be a function`);
	}

	const existing = registry.get(id);
	if (existing) {
		if (existing.builtin) {
			throw new Error(`registerSearchProvider "${id}" conflicts with a built-in search provider`);
		}
		if (existing.owner !== options.owner || options.owner === undefined) {
			throw new Error(`registerSearchProvider "${id}" is already registered by another owner`);
		}
	}

	registry.set(id, {
		id,
		label,
		...(descriptor.availability ? { availability: descriptor.availability } : {}),
		factory: descriptor.factory,
		builtin: false,
		...(options.owner !== undefined ? { owner: options.owner } : {}),
		...(options.generation !== undefined ? { generation: options.generation } : {}),
	});
	instances.delete(id);
	return project(registry.get(id)!);
}

/**
 * Remove a runtime provider. Built-ins are permanent: this returns `false` for
 * them and for ids this registry never saw. With `owner`, only that owner's
 * entry is removed, so an extension cannot drop another party's provider.
 */
export function unregisterSearchProvider(id: string, options: { owner?: string } = {}): boolean {
	const entry = registry.get(id);
	if (!entry || entry.builtin) return false;
	if (options.owner !== undefined && entry.owner !== options.owner) return false;
	registry.delete(id);
	instances.delete(id);
	return true;
}

/**
 * Release every entry one owner still holds. With `generation`, only entries
 * registered by that owner generation are removed, so an extension reload can
 * release its predecessor without touching the replacement's registrations.
 */
export function releaseSearchProviders(owner: string, generation?: object): string[] {
	const released: string[] = [];
	for (const [id, entry] of [...registry.entries()]) {
		if (entry.builtin || entry.owner !== owner) continue;
		if (generation !== undefined && entry.generation !== generation) continue;
		registry.delete(id);
		instances.delete(id);
		released.push(id);
	}
	return released;
}

/** Look up a descriptor without loading its implementation. */
export function getRegisteredSearchProvider(id: string): RegisteredSearchProvider | undefined {
	const entry = registry.get(id);
	return entry ? project(entry) : undefined;
}

/** Built-ins in the shipped order, then runtime providers in registration order. */
export function listRegisteredSearchProviders(): RegisteredSearchProvider[] {
	return [...registry.values()].map(project);
}

/** `true` when `id` names a built-in provider. */
export function isBuiltinSearchProvider(id: string): id is SearchProviderId {
	return SEARCH_PROVIDER_ORDER.includes(id as SearchProviderId);
}

/** Narrow a registered id into the dynamic channel; built-in ids stay in their union. */
export function toSearchProviderId(id: string): AnySearchProviderId {
	return isBuiltinSearchProvider(id) ? id : asDynamicSearchProviderId(id);
}

/**
 * Resolve a provider instance, loading and caching its implementation on first
 * use. Re-registration drops the cached instance.
 */
export async function resolveSearchProviderInstance(id: string): Promise<SearchProvider> {
	const cached = instances.get(id);
	if (cached) return cached;
	const entry = registry.get(id);
	if (!entry) throw new Error(`Unknown search provider: ${id}`);
	const provider = await entry.factory();
	instances.set(id, provider);
	return provider;
}
