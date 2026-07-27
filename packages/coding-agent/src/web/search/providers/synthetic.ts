/**
 * Synthetic Provider — returns mock results for testing.
 *
 * Always available. Provides canned responses so the provider chain
 * can be tested without network calls.
 */

import type { SearchParams, SearchResponse, SearchSource } from "../types.ts";
import { clampNumResults } from "../utils.ts";
import { SearchProvider } from "./base.ts";

const SYNTHETIC_RESULTS: SearchSource[] = [
	{
		title: "Mock Result 1",
		url: "https://example.com/1",
		snippet: "This is a synthetic search result for testing purposes.",
	},
	{
		title: "Mock Result 2",
		url: "https://example.com/2",
		snippet: "Another synthetic result with more detailed content for testing the provider chain.",
	},
	{
		title: "Mock Result 3",
		url: "https://example.com/3",
		snippet: "A third synthetic result to verify pagination and limits work correctly.",
	},
	{
		title: "Mock Result 4",
		url: "https://example.com/4",
		snippet: "Fourth synthetic entry for testing multi-result display.",
	},
	{ title: "Mock Result 5", url: "https://example.com/5", snippet: "Fifth and final default synthetic result." },
];

export class SyntheticProvider extends SearchProvider {
	readonly id = "synthetic" as const;
	readonly label = "Synthetic (test)";

	isAvailable(): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		const count = clampNumResults(params.limit, 5);
		const sources = SYNTHETIC_RESULTS.slice(0, count).map((s) => ({
			...s,
			snippet: s.snippet,
		}));
		return Promise.resolve({ sources });
	}
}
