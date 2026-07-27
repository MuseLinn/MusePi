/**
 * Web Search — provider orchestration and Tool adapter.
 *
 * The public API: call executeSearch(query) to get results via the
 * preferred provider (falling back through the chain on failure).
 */

import { getSearchProvider, resolveProviderCandidates } from "./provider.ts";
import type { SearchParams, SearchProviderId, SearchResponse } from "./types.ts";

export { getPreferredSearchProvider, setPreferredSearchProvider } from "./provider.ts";
export type { SearchParams, SearchProviderId, SearchResponse } from "./types.ts";
export {
	isSearchProviderId,
	isSearchProviderPreference,
	SEARCH_PROVIDER_LABELS,
	SEARCH_PROVIDER_OPTIONS,
} from "./types.ts";

/**
 * Execute a web search, trying providers in fallback order until one
 * succeeds or all fail.
 *
 * @returns Array of { provider, response } for successful searches,
 *          or an empty array if no provider returned results.
 */
export async function executeSearch(
	query: string,
	opts?: {
		limit?: number;
		recency?: string;
		signal?: AbortSignal;
		preferred?: SearchProviderId | "auto";
	},
): Promise<SearchResponse | undefined> {
	const candidates = resolveProviderCandidates(opts?.preferred);
	const errors: Array<{ id: string; error: Error }> = [];

	for (const candidate of candidates) {
		const provider = await getSearchProvider(candidate.id);
		if (!provider) continue;

		// Check availability
		const available = candidate.isExplicit ? await provider.isExplicitlyAvailable() : await provider.isAvailable();
		if (!available) continue;

		try {
			const params: SearchParams = {
				query,
				limit: opts?.limit,
				recency: opts?.recency,
				signal: opts?.signal,
			};
			const response = await provider.search(params);
			if (response.sources.length > 0) {
				return response;
			}
		} catch (error) {
			errors.push({ id: candidate.id, error: error as Error });
			// Continue to next candidate
		}
	}

	if (errors.length > 0) {
		// Re-throw the first error when no provider succeeded
		throw errors[0].error;
	}
	return undefined;
}
