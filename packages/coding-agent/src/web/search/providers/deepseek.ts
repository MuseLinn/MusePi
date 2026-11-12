/**
 * DeepSeek Web Search Provider
 *
 * Uses DeepSeek's documented Search API (`POST /v1/tools/search`), which
 * returns structured, ranked results from DeepSeek's in-house search engine.
 * Requires `DEEPSEEK_API_KEY` or a stored `deepseek` credential.
 *
 * Docs: https://api-docs.deepseek.com/api/search
 */
import { type ApiKey, type AuthStorage, type FetchImpl, getEnvApiKey, withAuth } from "@musepi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;
/** `query`/`ori_question` are documented as 1–128 Unicode characters. */
const MAX_QUERY_CHARS = 128;

/** DeepSeek documents `site:`, `-site:`, `-term`, `-"phrase"`, `"phrase"`, `lang:`, `after:`, `before:`. */
const DEEPSEEK_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	or: true,
	site: true,
	dateRange: true,
};

const RECENCY_DAYS: Record<"day" | "week" | "month" | "year", number> = {
	day: 1,
	week: 7,
	month: 30,
	year: 365,
};

interface DeepSeekSearchResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	summary?: unknown;
	date?: unknown;
	site_name?: unknown;
}

interface DeepSeekSearchResponse {
	results?: unknown;
}

export interface DeepSeekSearchParams {
	query: string;
	parsedQuery?: StructuredQuery;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
	timeoutMs?: number;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
}

function asTrimmed(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : value.slice(0, max);
}

/**
 * Absolute lower bound for the recency window. DeepSeek has no dedicated
 * freshness parameter, and `after:` is a pure publish-date filter there, so
 * recency maps onto it directly. Explicit `after:`/`before:` directives win.
 */
function recencyBound(parsed: StructuredQuery, recency?: DeepSeekSearchParams["recency"]): string | undefined {
	if (!recency || parsed.after || parsed.before) return undefined;
	const since = new Date(Date.now() - RECENCY_DAYS[recency] * 86_400_000);
	return `after:${since.toISOString().slice(0, 10)}`;
}

/** Request body of the documented Search API. */
export interface DeepSeekSearchRequestBody {
	query: string;
	count: number;
	need_content: false;
	ori_question?: string;
}

/** Exported for testing. Builds the request body from unified params. */
export function buildDeepSeekRequestBody(params: DeepSeekSearchParams): DeepSeekSearchRequestBody {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	let query = parsed.hasDirectives ? formatQuery(parsed, DEEPSEEK_QUERY_SYNTAX) : params.query;
	if (parsed.hasDirectives && parsed.lang) query = `${query} lang:${parsed.lang}`;
	const bound = recencyBound(parsed, params.recency);
	if (bound) query = `${query} ${bound}`;

	const body: DeepSeekSearchRequestBody = {
		query: truncate(query, MAX_QUERY_CHARS),
		count: clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS),
		need_content: false,
	};
	// The raw question sharpens query understanding whenever formatting changed it.
	if (query !== params.query && params.query.length <= MAX_QUERY_CHARS) {
		body.ori_question = params.query;
	}
	return body;
}

function errorMessage(body: string): string {
	try {
		const payload: unknown = JSON.parse(body);
		if (typeof payload === "object" && payload !== null) {
			const error = (payload as { error?: unknown }).error;
			if (typeof error === "object" && error !== null) {
				const message = (error as { message?: unknown }).message;
				if (typeof message === "string" && message.trim()) return message.trim();
			}
		}
	} catch {
		// Non-JSON error bodies keep their raw text.
	}
	return body.trim();
}

async function callDeepSeekSearch(
	apiKey: string,
	body: DeepSeekSearchRequestBody,
	params: DeepSeekSearchParams,
): Promise<DeepSeekSearchResponse> {
	const response = await (params.fetch ?? fetch)(DEEPSEEK_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("deepseek", response.status, errorText);
		if (classified) throw classified;
		const message = errorMessage(errorText) || response.statusText;
		throw new SearchProviderError("deepseek", `DeepSeek API error (${response.status}): ${message}`, response.status);
	}

	const payload: unknown = await response.json().catch(() => null);
	if (typeof payload !== "object" || payload === null) {
		throw new SearchProviderError("deepseek", "DeepSeek API returned invalid JSON", 500);
	}
	return payload as DeepSeekSearchResponse;
}

function toSearchResponse(response: DeepSeekSearchResponse, numResults: number): SearchResponse {
	const sources: SearchSource[] = [];
	if (Array.isArray(response.results)) {
		for (const value of response.results) {
			if (typeof value !== "object" || value === null) continue;
			const result = value as DeepSeekSearchResult;
			const url = asTrimmed(result.url);
			if (!url) continue;
			const publishedDate = asTrimmed(result.date);
			sources.push({
				title: asTrimmed(result.title) ?? url,
				url,
				// `summary` is the model-facing blurb; `snippet` is the short UI one.
				snippet: asTrimmed(result.summary) ?? asTrimmed(result.snippet),
				publishedDate,
				ageSeconds: dateToAgeSeconds(publishedDate),
				author: asTrimmed(result.site_name),
			});
		}
	}
	return {
		provider: "deepseek",
		sources: sources.slice(0, numResults),
		authMode: "api_key",
	};
}

/** Execute DeepSeek web search. */
export async function searchDeepSeek(params: DeepSeekSearchParams): Promise<SearchResponse> {
	const body = buildDeepSeekRequestBody(params);
	const numResults = body.count;
	const keyOrResolver: ApiKey = params.authStorage.resolver("deepseek", { sessionId: params.sessionId });
	const response = await withAuth(keyOrResolver, apiKey => callDeepSeekSearch(apiKey, body, params), {
		signal: params.signal,
		missingKeyMessage:
			'DeepSeek credentials not found. Set DEEPSEEK_API_KEY or configure an API key for provider "deepseek".',
	});
	return toSearchResponse(response, numResults);
}

/** Search provider for DeepSeek's web search API. */
export class DeepSeekProvider extends SearchProvider {
	readonly id = "deepseek";
	readonly label = "DeepSeek";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("deepseek") || !!getEnvApiKey("deepseek");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDeepSeek({
			query: params.query,
			parsedQuery: params.parsedQuery,
			num_results: params.numSearchResults ?? params.limit,
			recency: params.recency,
			signal: params.signal,
			timeoutMs: params.timeoutMs,
			authStorage: params.authStorage,
			sessionId: params.sessionId,
			fetch: params.fetch,
		});
	}
}
