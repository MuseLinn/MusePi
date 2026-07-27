/**
 * Web Search Provider — abstract base class.
 *
 * Each provider implements the same search contract: accept params,
 * return structured results (or throw SearchProviderError).
 */
import type { SearchParams, SearchProviderId, SearchResponse } from "../types.ts";

/** Unique id for a provider (matches SearchProviderId + "auto"). */
export type ProviderId = SearchProviderId | "auto";

/**
 * Abstract base for all search providers.
 *
 * Subclasses MUST define id, label, isAvailable, and search.
 * isExplicitlyAvailable can be overridden when a provider is explicitly
 * selected by the user but needs special handling (e.g. Exa falls back
 * to a public MCP when no credential is configured).
 */
export abstract class SearchProvider {
	abstract readonly id: SearchProviderId;
	abstract readonly label: string;

	/**
	 * Auto-chain admission. Called during fallback walking; return false
	 * to skip this provider when it cannot operate (no credential, offline, etc.).
	 */
	abstract isAvailable(): Promise<boolean> | boolean;

	/**
	 * Explicit selection admission. Defaults to isAvailable(). Override when
	 * a provider should work when explicitly chosen even if isAvailable()
	 * returns false (e.g. public-MCP fallback).
	 */
	isExplicitlyAvailable(): Promise<boolean> | boolean {
		return this.isAvailable();
	}

	/**
	 * Execute a search and return structured results.
	 * Throw SearchProviderError on non-retryable failures; return
	 * empty SearchResponse to let the fallback chain continue.
	 */
	abstract search(params: SearchParams): Promise<SearchResponse>;
}
