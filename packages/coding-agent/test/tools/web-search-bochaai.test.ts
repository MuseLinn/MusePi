import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, type FetchImpl, SqliteAuthCredentialStore } from "@musepi/pi-ai";
import { searchBochaai } from "@musepi/pi-coding-agent/web/search/providers/bochaai";

const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
afterAll(() => authStorage.close());

const originalApiKey = process.env.BOCHAAI_API_KEY;
afterEach(() => {
	if (originalApiKey === undefined) {
		delete process.env.BOCHAAI_API_KEY;
	} else {
		process.env.BOCHAAI_API_KEY = originalApiKey;
	}
});

function webPage(name: string, url: string, extra?: Record<string, unknown>) {
	return { name, url, ...extra };
}

describe("Bochaai web search", () => {
	it("posts to the Bochaai web-search API and maps webPages into sources", async () => {
		process.env.BOCHAAI_API_KEY = "test-bochaai-key";
		let capturedUrl: string | undefined;
		let capturedAuth: string | null | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl = String(input);
			capturedAuth = new Headers(init?.headers).get("Authorization");
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					code: 200,
					data: {
						webPages: {
							value: [
								webPage("Example One", "https://example.com/one", {
									summary: "Summary one.",
									snippet: "Snippet one.",
									siteName: "Example",
									datePublished: "2026-09-20T08:00:00",
								}),
								webPage("Example Two", "https://example.com/two", { snippet: "Snippet two." }),
							],
						},
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const response = await searchBochaai({ query: "苋菜 种植", authStorage, fetch: fetchMock });

		expect(capturedUrl).toBe("https://api.bochaai.com/v1/web-search");
		expect(capturedAuth).toBe("Bearer test-bochaai-key");
		expect(capturedBody).toMatchObject({ query: "苋菜 种植", count: 10, freshness: "noLimit" });
		expect(response.provider).toBe("bochaai");
		expect(response.sources).toHaveLength(2);
		// `summary` wins over `snippet`: the API emits a richer summary when asked for one.
		expect(response.sources[0]).toMatchObject({
			title: "Example One",
			url: "https://example.com/one",
			snippet: "Summary one.",
			publishedDate: "2026-09-20T08:00:00",
			author: "Example",
		});
		expect(response.sources[1]?.snippet).toBe("Snippet two.");
	});

	it("maps recency to the freshness enum", async () => {
		process.env.BOCHAAI_API_KEY = "test-bochaai-key";
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(JSON.stringify({ code: 200, data: { webPages: { value: [] } } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchBochaai({ query: "news", recency: "week", authStorage, fetch: fetchMock });

		expect(capturedBody?.freshness).toBe("oneWeek");
	});

	it("classifies a 401 as an authorization failure so the chain reports a clean cause", async () => {
		process.env.BOCHAAI_API_KEY = "bad-key";
		const fetchMock: FetchImpl = async () => new Response("unauthorized", { status: 401 });

		const failure = await searchBochaai({ query: "anything", authStorage, fetch: fetchMock }).catch(error => error);

		expect((failure as Error).message).toContain("401");
	});

	it("surfaces API-level error codes from a 200 envelope", async () => {
		process.env.BOCHAAI_API_KEY = "test-bochaai-key";
		const fetchMock: FetchImpl = async () =>
			new Response(JSON.stringify({ code: 500, message: "upstream broke" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const failure = await searchBochaai({ query: "anything", authStorage, fetch: fetchMock }).catch(error => error);

		expect((failure as Error).message).toContain("upstream broke");
	});
});
