/**
 * Web Search Provider Registry — lazy dynamic-import provider lookup,
 * singleton cache, fallback ordering.
 *
 * Each provider module is loaded on first access (lazy import), then
 * cached as a singleton per id.
 */

import type { SearchProvider } from "./providers/base.ts";
import type { SearchProviderId } from "./types.ts";
import { SEARCH_PROVIDER_ORDER } from "./types.ts";

// ── Provider meta: lazy-loaded via dynamic import ──────────────

interface ProviderMeta {
	id: SearchProviderId;
	label: string;
	/** Returns a new class instance. MUST be a class expression, not a singleton. */
	load: () => Promise<SearchProvider>;
}

function lazyProvider(id: SearchProviderId, label: string, mod: string): ProviderMeta {
	return {
		id,
		label,
		// Dynamic import: provider modules are loaded lazily by user-selected id.
		// The full set is known at author time, but loading all would waste memory
		// and startup time for unused providers.
		load: async () => {
			const m = await import(`./providers/${mod}.ts`);
			const Ctor = Object.values(m).find((v) => typeof v === "function" && "id" in (v.prototype ?? {})) as
				| (new () => SearchProvider)
				| undefined;
			if (!Ctor) throw new Error(`Provider module ${mod} has no SearchProvider subclass`);
			return new Ctor();
		},
	};
}

const PROVIDER_META: Record<string, ProviderMeta> = {
	brave: lazyProvider("brave", "Brave", "brave"),
	duckduckgo: lazyProvider("duckduckgo", "DuckDuckGo", "duckduckgo"),
	synthetic: lazyProvider("synthetic", "Synthetic (test)", "synthetic"),
};

// ── Singleton cache ────────────────────────────────────────────

const instanceCache = new Map<string, SearchProvider>();

/** Get a provider singleton, loading it on first access. */
export async function getSearchProvider(id: string): Promise<SearchProvider | undefined> {
	if (instanceCache.has(id)) return instanceCache.get(id);
	const meta = PROVIDER_META[id];
	if (!meta) return undefined;
	const instance = await meta.load();
	instanceCache.set(id, instance);
	return instance;
}

/** Preload a provider into the cache (used during initialization). */
export function setSearchProviderInstance(id: string, provider: SearchProvider): void {
	instanceCache.set(id, provider);
}

// ── In-memory preference (backed by musepi settings eventually) ─

const excludedProviders = new Set<string>();

let preferredProvider: SearchProviderId | "auto" = "auto";

export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvider = provider;
}

export function getPreferredSearchProvider(): SearchProviderId | "auto" {
	return preferredProvider;
}

export function setExcludedSearchProviders(ids: string[]): void {
	excludedProviders.clear();
	for (const id of ids) excludedProviders.add(id);
}

export function getExcludedSearchProviders(): string[] {
	return [...excludedProviders];
}

// ── Fallback chain resolution ──────────────────────────────────

export interface SearchProviderCandidate {
	id: SearchProviderId;
	isExplicit: boolean;
}

/**
 * Resolve the ordered list of provider candidates.
 *
 * If preferred is "auto", returns all non-excluded providers in order.
 * If a specific provider, returns it first, then falls back to other
 * non-excluded providers.
 */
export function resolveProviderCandidates(preferred?: SearchProviderId | "auto"): SearchProviderCandidate[] {
	const pref = preferred ?? preferredProvider;
	const skip = new Set(excludedProviders);

	if (pref === "auto") {
		return SEARCH_PROVIDER_ORDER.filter((id) => !skip.has(id)).map((id) => ({ id, isExplicit: false }));
	}

	// Explicit: chosen provider first, then auto-chain others
	const candidates: SearchProviderCandidate[] = [{ id: pref, isExplicit: true }];
	skip.add(pref);
	for (const id of SEARCH_PROVIDER_ORDER) {
		if (!skip.has(id)) {
			candidates.push({ id, isExplicit: false });
		}
	}
	return candidates;
}
