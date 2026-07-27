/**
 * Brave Search Provider — uses the Brave Search API.
 *
 * Requires BRAVE_API_KEY env var.
 * Docs: https://api.search.brave.com/app/documentation/web-search
 */

import type { SearchParams, SearchResponse, SearchSource } from "../types.ts";
import { SearchProvider } from "./base.ts";
import { classifyProviderHttpError, findApiKey, toSearchSources, withTimeoutSignal } from "./utils.ts";

const API_URL = "https://api.search.brave.com/res/v1/web/search";

function searchBrave(
	query: string,
	apiKey: string,
	opts: { count?: number; recency?: string; signal?: AbortSignal },
): Promise<SearchResponse> {
	const url = new URL(API_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(opts.count ?? 5));
	url.searchParams.set("extra_snippets", "true");
	if (opts.recency) {
		url.searchParams.set("freshness", opts.recency);
	}

	const signal = withTimeoutSignal(opts.signal, 60_000);

	return fetch(url.toString(), {
		signal,
		headers: {
			Accept: "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
	}).then(async (response) => {
		if (!response.ok) {
			const body = await response.text().catch(() => undefined);
			const classified = classifyProviderHttpError(response.status, body);
			throw Object.assign(new Error(classified.message), { status: response.status });
		}
		const data = (await response.json()) as {
			web?: { results?: Array<BraveResult> };
		};
		const sources: SearchSource[] = toSearchSources(
			(data.web?.results ?? []).map((r: BraveResult) => ({
				title: r.title,
				url: r.url,
				snippet: r.description ?? r.snippet ?? "",
				ageSeconds: r.age ? parseAge(r.age) : undefined,
			})),
		);
		return { sources } satisfies SearchResponse;
	});
}

interface BraveResult {
	title: string;
	url: string;
	description?: string;
	snippet?: string;
	age?: string;
}

/** Parse Brave's age string like "1 day ago", "2 hours ago" to seconds. */
function parseAge(age: string): number | undefined {
	const match = age.match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
	if (!match) return undefined;
	const n = Number(match[1]);
	switch (match[2]) {
		case "second":
			return n;
		case "minute":
			return n * 60;
		case "hour":
			return n * 3600;
		case "day":
			return n * 86400;
		case "week":
			return n * 604800;
		case "month":
			return n * 2592000;
		case "year":
			return n * 31536000;
		default:
			return undefined;
	}
}

export class BraveProvider extends SearchProvider {
	readonly id = "brave" as const;
	readonly label = "Brave";

	isAvailable(): boolean {
		return !!findApiKey("BRAVE_API_KEY");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		const apiKey = findApiKey("BRAVE_API_KEY");
		if (!apiKey) {
			return Promise.reject(new Error("BRAVE_API_KEY not set"));
		}
		return searchBrave(params.query, apiKey, {
			count: params.limit,
			recency: params.recency,
			signal: params.signal,
		});
	}
}
