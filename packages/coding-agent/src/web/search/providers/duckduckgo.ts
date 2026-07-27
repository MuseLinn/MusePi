/**
 * DuckDuckGo Provider — credential-free HTML scrape.
 *
 * No API key needed. Used as a last-resort fallback when no other
 * provider is configured.
 */

import type { SearchParams, SearchResponse, SearchSource } from "../types.ts";
import { SearchProvider } from "./base.ts";
import { withTimeoutSignal } from "./utils.ts";

const DDG_URL = "https://html.duckduckgo.com/html/";

function searchDuckDuckGo(query: string, opts: { count?: number; signal?: AbortSignal }): Promise<SearchResponse> {
	const signal = withTimeoutSignal(opts.signal, 30_000);

	return fetch(DDG_URL, {
		method: "POST",
		signal,
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ q: query }),
	})
		.then((response) => response.text())
		.then((html) => {
			const sources: SearchSource[] = [];
			// Simple regex-based extraction from the HTML response
			const resultRegex =
				/<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>\s*<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
			for (;;) {
				const match = resultRegex.exec(html);
				if (!match) break;
				if (opts.count && sources.length >= opts.count) break;
				const url = decodeHtmlEntities(match[1]);
				const title = stripHtml(match[2]);
				const snippet = stripHtml(match[3]);
				if (url && title) {
					sources.push({ title, url, snippet });
				}
			}
			return { sources } satisfies SearchResponse;
		});
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&#x2F;/g, "/");
}

function stripHtml(text: string): string {
	return text.replace(/<[^>]*>/g, "").trim();
}

export class DuckDuckGoProvider extends SearchProvider {
	readonly id = "duckduckgo" as const;
	readonly label = "DuckDuckGo";

	isAvailable(): boolean {
		return true; // Always available — no credential needed
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchDuckDuckGo(params.query, {
			count: params.limit,
			signal: params.signal,
		});
	}
}
