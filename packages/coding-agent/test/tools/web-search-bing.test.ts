import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { AuthStorage, type FetchImpl, SqliteAuthCredentialStore } from "@musepi/pi-ai";
import type { SearchParams } from "@musepi/pi-coding-agent/web/search/providers/base";
import { searchBing } from "@musepi/pi-coding-agent/web/search/providers/bing";
import { SearchProviderError } from "@musepi/pi-coding-agent/web/search/types";

const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
afterAll(() => authStorage.close());

function makeParams(query: string, fetch: FetchImpl, extra?: Partial<SearchParams>): SearchParams {
	return {
		query,
		authStorage,
		systemPrompt: "Bing search test prompt",
		fetch,
		...extra,
	};
}

function bingResult(href: string, title: string, snippet?: string): string {
	return `<li class="b_algo"><h2><a href="${href}">${title}</a></h2><div class="b_caption">${snippet ? `<p>${snippet}</p>` : ""}</div></li>`;
}

/** The `u` param Bing puts on `ck/a` redirect links: `a1` prefix + base64url target. */
function bingRedirect(target: string): string {
	return `https://cn.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(target).toString("base64url")}&ntb=1`;
}

describe("Bing web search", () => {
	it("queries the mainland-reachable cn.bing.com SERP and parses organic results", async () => {
		let capturedUrl: string | undefined;
		const fetchMock: FetchImpl = async input => {
			capturedUrl = String(input);
			const html = `<ol id="b_results">
				${bingResult("https://example.com/one", "Example One", "Snippet one.")}
				${bingResult(bingRedirect("https://example.com/two"), "Example Two")}
			</ol>`;
			return new Response(html, { status: 200 });
		};

		const response = await searchBing(makeParams("open source software", fetchMock));

		expect(capturedUrl).toBeDefined();
		const url = new URL(capturedUrl as string);
		expect(url.hostname).toBe("cn.bing.com");
		expect(url.searchParams.get("q")).toBe("open source software");
		expect(response.provider).toBe("bing");
		expect(response.sources).toEqual([
			{ title: "Example One", url: "https://example.com/one", snippet: "Snippet one." },
			{ title: "Example Two", url: "https://example.com/two", snippet: undefined },
		]);
	});

	it("maps recency to the Bing filters param", async () => {
		let capturedUrl: string | undefined;
		const fetchMock: FetchImpl = async input => {
			capturedUrl = String(input);
			return new Response(`<ol id="b_results">${bingResult("https://example.com/a", "A")}</ol>`, { status: 200 });
		};

		await searchBing(makeParams("news", fetchMock, { recency: "week" }));

		expect(new URL(capturedUrl as string).searchParams.get("filters")).toBe('ex1:"ez2"');
	});

	it("raises a provider-tagged 429 when Bing serves its CAPTCHA wall", async () => {
		const fetchMock: FetchImpl = async () => new Response('<div id="b_captcha"></div>', { status: 200 });

		const failure = await searchBing(makeParams("anything", fetchMock)).catch(error => error);

		expect(failure).toBeInstanceOf(SearchProviderError);
		expect((failure as SearchProviderError).status).toBe(429);
	});

	it("propagates connection-level fetch failures unchanged so the failover chain can classify them", async () => {
		const fetchMock: FetchImpl = async () => {
			throw new Error("Unable to connect. Is the computer able to access the url?");
		};

		const failure = await searchBing(makeParams("anything", fetchMock)).catch(error => error);

		expect((failure as Error).message).toContain("Unable to connect");
	});
});
