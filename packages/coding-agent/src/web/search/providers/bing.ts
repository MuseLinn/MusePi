/**
 * Bing Web Search Provider (no API key required)
 *
 * Scrapes the server-rendered `cn.bing.com` SERP. The `cn.bing.com` endpoint
 * is reachable from mainland China without a proxy, which makes this the
 * credential-free fallback of last resort there: every other keyless engine
 * (Startpage, DuckDuckGo, Ecosia, Google, Mojeek) is hosted overseas and
 * fails at the TCP/TLS level on a direct connection.
 */
import type { AuthStorage } from "@musepi/pi-ai";
import { parseHTML } from "@musepi/pi-utils/dom";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatScraperQuery, GOOGLE_QUERY_SYNTAX, type QuerySyntax } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import type { LoadedHtmlPage } from "./browser-page";
import { browserFetch } from "./browser-page";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const BING_SEARCH_URL = "https://cn.bing.com/search";
const BING_HOME_URL = "https://cn.bing.com/";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

/**
 * Bing parses the classic operator set (site:, quotes, -, OR, filetype:), but
 * date bounds map onto the native `filters` param, so `before:`/`after:`
 * tokens are stripped from the rebuilt query string.
 */
const BING_QUERY_SYNTAX: QuerySyntax = { ...GOOGLE_QUERY_SYNTAX, dateRange: false };

const RECENCY_TO_BING_EZ: Record<"day" | "week" | "month", string> = {
	day: "ez1",
	week: "ez2",
	month: "ez3",
};

/**
 * Recency → Bing `filters=ex1:"…"` param. Day/week/month use the fixed `ez1`
 * /`ez2`/`ez3` codes; a year is a custom `ez5_<startDay>_<endDay>` range with
 * both bounds as days since the Unix epoch.
 */
function bingRecencyFilter(recency: NonNullable<SearchParams["recency"]>): string {
	if (recency === "year") {
		const endDay = Math.floor(Date.now() / 86_400_000);
		return `ex1:"ez5_${endDay - 365}_${endDay}"`;
	}
	return `ex1:"${RECENCY_TO_BING_EZ[recency]}"`;
}

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Resolve a Bing result href back to the underlying target URL.
 *
 * Bing routes outbound clicks through `<host>/ck/a?…&u=a1<base64url>&ntb=1`
 * redirect links; the `u` value is the target URL base64url-encoded behind a
 * two-character `a1` version prefix. Direct http(s) hrefs pass through.
 */
function unwrapResultUrl(href: string | null | undefined): string | undefined {
	if (!href) return undefined;
	let url: URL;
	try {
		url = new URL(href, BING_HOME_URL);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const wrapped = url.searchParams.get("u");
	if (url.pathname === "/ck/a" && wrapped?.startsWith("a1")) {
		try {
			const target = Buffer.from(wrapped.slice(2), "base64url").toString("utf-8");
			const targetUrl = new URL(target);
			if (targetUrl.protocol === "http:" || targetUrl.protocol === "https:") return targetUrl.href;
		} catch {
			return undefined;
		}
		return undefined;
	}
	return url.href;
}

/**
 * `true` when Bing answered with its CAPTCHA wall instead of results. The
 * challenge page renders a `b_captcha` container; a bare "captcha" substring
 * is deliberately not used — result snippets for captcha-related queries
 * would false-positive.
 */
function isChallengeResponse(page: LoadedHtmlPage): boolean {
	return page.html.includes("b_captcha");
}

/**
 * Walk the server-rendered SERP in document order.
 *
 * Each organic hit lives in a `li.b_algo` container holding the title anchor
 * `h2 > a` and an optional `.b_caption p` snippet. Sponsored placements
 * render outside `li.b_algo` containers and are skipped.
 */
function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const item of document.querySelectorAll("li.b_algo")) {
		const anchor = item.querySelector("h2 a");
		if (!anchor) continue;
		const url = unwrapResultUrl(anchor.getAttribute("href"));
		if (!url) continue;
		const title = normalizeText(anchor.textContent);
		if (!title) continue;
		const snippet = normalizeText(item.querySelector(".b_caption p")?.textContent);
		results.push({ title, url, snippet: snippet || undefined });
	}
	return results;
}

async function callBingHtml(params: SearchParams): Promise<string> {
	const query = formatScraperQuery(params.query, params.parsedQuery, BING_QUERY_SYNTAX);
	const url = new URL(BING_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(MAX_NUM_RESULTS));
	if (params.recency) url.searchParams.set("filters", bingRecencyFilter(params.recency));

	const page = await browserFetch(url.href, {
		fetch: params.fetch ?? fetch,
		signal: withHardTimeout(params.signal, params.timeoutMs),
		timeoutMs: params.timeoutMs,
		referer: BING_HOME_URL,
	});

	if (isChallengeResponse(page)) {
		throw new SearchProviderError(
			"bing",
			"Bing blocked the request with a CAPTCHA challenge; try another provider or retry later.",
			429,
		);
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("bing", page.status, page.html);
		if (classified) throw classified;
		throw new SearchProviderError("bing", `Bing HTML error (${page.status})`, page.status);
	}
	return page.html;
}

/** Execute a Bing web search via the cn.bing.com SERP. */
export async function searchBing(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const html = await callBingHtml(params);

	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parseHtmlResults(html)) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}

	return { provider: "bing", sources };
}

/** Search provider for Bing (no API key required). */
export class BingProvider extends SearchProvider {
	readonly id = "bing";
	readonly label = "Bing";

	isAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBing(params);
	}
}
