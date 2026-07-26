/**
 * Web Search Types — minimal port from OMP for setup wizard integration.
 *
 * Full provider chain (resolving, fallbacks, render) lives in
 * providers/ and index.ts, ported incrementally.
 */

export const SEARCH_PROVIDER_OPTIONS = [
	{ value: "brave", label: "Brave Search", description: "Free tier — api.search.brave.com" },
	{ value: "google", label: "Google Custom Search", description: "Requires CX + API key" },
	{ value: "bing", label: "Bing Search", description: "Azure Bing Search API key" },
	{ value: "duckduckgo", label: "DuckDuckGo", description: "No API key needed, rate-limited" },
	{ value: "kagi", label: "Kagi", description: "Paid — kagi.com" },
	{ value: "searxng", label: "SearXNG", description: "Self-hosted — searxng settings" },
	{ value: "tavily", label: "Tavily", description: "tavily.com API key" },
	{ value: "anthropic", label: "Anthropic", description: "Built-in (Claude models)" },
	{ value: "perplexity", label: "Perplexity", description: "perplexity.ai API key" },
	{ value: "jina", label: "Jina AI", description: "jina.ai API key" },
	{ value: "firecrawl", label: "Firecrawl", description: "firecrawl.dev API key" },
	{ value: "exa", label: "Exa", description: "exa.ai API key" },
	{ value: "mojeek", label: "Mojeek", description: "mojeek.com API key" },
	{ value: "startpage", label: "Startpage", description: "startpage.com API key" },
	{ value: "ecosia", label: "Ecosia", description: "ecosia.org" },
	{ value: "tinyfish", label: "Tinyfish", description: "tinyfish.io" },
] as const;

export type SearchProviderId = (typeof SEARCH_PROVIDER_OPTIONS)[number]["value"];

export const SEARCH_PROVIDER_ORDER: readonly SearchProviderId[] = SEARCH_PROVIDER_OPTIONS.map((o) => o.value);

export const SEARCH_PROVIDER_LABELS = Object.fromEntries(
	SEARCH_PROVIDER_OPTIONS.map((o) => [o.value, o.label]),
) as Record<SearchProviderId, string>;

export function isSearchProviderId(value: string): value is SearchProviderId {
	return SEARCH_PROVIDER_ORDER.includes(value as SearchProviderId);
}

export function isSearchProviderPreference(value: string): value is SearchProviderId | "auto" {
	return value === "auto" || isSearchProviderId(value);
}

/** Provider-specific error with optional HTTP status */
export class SearchProviderError extends Error {
	status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "SearchProviderError";
		this.status = status;
	}
}

/** Unified search response across providers */
export interface SearchResponse {
	sources: SearchSource[];
	usage?: SearchUsage;
}

export interface SearchSource {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchUsage {
	requestCount: number;
	totalTokens?: number;
}
