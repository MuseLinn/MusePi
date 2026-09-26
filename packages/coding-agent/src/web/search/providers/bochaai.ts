/**
 * Bochaai (博查) Web Search Provider
 *
 * China-hosted search API built for AI applications; reachable from mainland
 * China without a proxy. Requires a Bochaai API key (`BOCHAAI_API_KEY` or a
 * stored `bochaai` credential).
 * Endpoint: POST https://api.bochaai.com/v1/web-search
 */
import { type ApiKey, type AuthStorage, type FetchImpl, withAuth } from "@musepi/pi-ai";
import { $env } from "@musepi/pi-utils";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery, type QuerySyntax, type StructuredQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const BOCHAAI_SEARCH_URL = "https://api.bochaai.com/v1/web-search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 50;

/** Bochaai parses a Bing-flavored operator set; date bounds map onto the native `freshness` param. */
const BOCHAAI_QUERY_SYNTAX: QuerySyntax = {
	phrases: true,
	negation: true,
	site: true,
	inTitle: true,
	inUrl: true,
	filetype: true,
};

const RECENCY_MAP: Record<"day" | "week" | "month" | "year", string> = {
	day: "oneDay",
	week: "oneWeek",
	month: "oneMonth",
	year: "oneYear",
};

interface BochaaiWebPage {
	name?: string;
	url?: string;
	snippet?: string;
	summary?: string;
	siteName?: string;
	datePublished?: string;
}

interface BochaaiSearchResponse {
	code?: number;
	message?: string | null;
	data?: { webPages?: { value?: BochaaiWebPage[] } };
	/** Older responses place `webPages` at the top level (Bing-compatible shape). */
	webPages?: { value?: BochaaiWebPage[] };
}

function asTrimmed(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the Bochaai credential. Highest precedence is the env override
 * (`BOCHAAI_API_KEY` / `BOCHA_API_KEY`); otherwise an AuthStorage-backed
 * resolver for a stored `bochaai` credential so a stale key triggers the
 * central refresh/rotate retry. Returns `undefined` when neither is
 * configured.
 */
async function resolveKey(
	authStorage: AuthStorage,
	sessionId: string | undefined,
	signal: AbortSignal | undefined,
): Promise<ApiKey | undefined> {
	const envKey = asTrimmed($env.BOCHAAI_API_KEY) ?? asTrimmed($env.BOCHA_API_KEY);
	if (envKey) return envKey;

	const stored = await authStorage.getApiKey("bochaai", sessionId, { signal });
	if (stored) return authStorage.resolver("bochaai", { sessionId });
	return undefined;
}

/**
 * Freshness param: explicit `after:`/`before:` bounds win over the
 * recency-derived window, rendered as Bochaai's absolute
 * `YYYY-MM-DD..YYYY-MM-DD` range with sensible open ends.
 */
function bochaaiFreshness(parsed: StructuredQuery, recency?: keyof typeof RECENCY_MAP): string | undefined {
	if (parsed.after || parsed.before) {
		const start = parsed.after ?? "1970-01-01";
		const end = parsed.before ?? new Date().toISOString().slice(0, 10);
		return `${start}..${end}`;
	}
	return recency ? RECENCY_MAP[recency] : undefined;
}

async function callBochaaiSearch(
	apiKey: string,
	params: {
		query: string;
		count: number;
		freshness?: string;
		signal?: AbortSignal;
		timeoutMs?: number;
		fetch?: FetchImpl;
	},
): Promise<{ response: BochaaiSearchResponse; requestId?: string }> {
	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(BOCHAAI_SEARCH_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			query: params.query,
			count: params.count,
			summary: true,
			freshness: params.freshness ?? "noLimit",
		}),
		signal: withHardTimeout(params.signal, params.timeoutMs),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("bochaai", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("bochaai", `Bochaai API error (${response.status}): ${errorText}`, response.status);
	}

	let data: BochaaiSearchResponse;
	try {
		data = (await response.json()) as BochaaiSearchResponse;
	} catch {
		throw new SearchProviderError("bochaai", "Bochaai API returned invalid JSON", 500);
	}
	if (typeof data.code === "number" && data.code !== 200) {
		const classified = classifyProviderHttpError("bochaai", data.code, data.message ?? "");
		if (classified) throw classified;
		throw new SearchProviderError(
			"bochaai",
			`Bochaai API error (${data.code}): ${data.message ?? "unknown error"}`,
			data.code,
		);
	}
	const requestId = response.headers.get("x-request-id") ?? undefined;
	return { response: data, requestId };
}

/** Execute Bochaai web search. */
export async function searchBochaai(params: {
	query: string;
	parsedQuery?: StructuredQuery;
	num_results?: number;
	recency?: SearchParams["recency"];
	signal?: AbortSignal;
	timeoutMs?: number;
	authStorage: AuthStorage;
	sessionId?: string;
	fetch?: FetchImpl;
}): Promise<SearchResponse> {
	const keyOrResolver = await resolveKey(params.authStorage, params.sessionId, params.signal);
	if (!keyOrResolver) {
		throw new Error(
			'Bochaai credentials not found. Set BOCHAAI_API_KEY or configure an API key for provider "bochaai".',
		);
	}

	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const query = parsed.hasDirectives ? formatQuery(parsed, BOCHAAI_QUERY_SYNTAX) : params.query;
	const count = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const { response, requestId } = await withAuth(
		keyOrResolver,
		key =>
			callBochaaiSearch(key, {
				query,
				count,
				freshness: bochaaiFreshness(parsed, params.recency),
				signal: params.signal,
				timeoutMs: params.timeoutMs,
				fetch: params.fetch,
			}),
		{ signal: params.signal },
	);

	const sources: SearchSource[] = [];
	for (const result of response.data?.webPages?.value ?? response.webPages?.value ?? []) {
		if (!result.url) continue;
		const publishedDate = asTrimmed(result.datePublished);
		sources.push({
			title: asTrimmed(result.name) ?? result.url,
			url: result.url,
			snippet: asTrimmed(result.summary) ?? asTrimmed(result.snippet),
			publishedDate,
			ageSeconds: dateToAgeSeconds(publishedDate),
			author: asTrimmed(result.siteName),
		});
	}

	return {
		provider: "bochaai",
		sources: sources.slice(0, count),
		requestId,
		authMode: "api_key",
	};
}

/** Search provider for Bochaai (博查) web search. */
export class BochaaiProvider extends SearchProvider {
	readonly id = "bochaai";
	readonly label = "Bochaai";

	isAvailable(authStorage: AuthStorage): boolean {
		return !!asTrimmed($env.BOCHAAI_API_KEY) || !!asTrimmed($env.BOCHA_API_KEY) || authStorage.hasAuth("bochaai");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBochaai({
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
