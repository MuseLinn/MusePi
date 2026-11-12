import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, type FetchImpl, SqliteAuthCredentialStore } from "@musepi/pi-ai";
import { buildDeepSeekRequestBody, searchDeepSeek } from "@musepi/pi-coding-agent/web/search/providers/deepseek";

const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
afterAll(() => authStorage.close());

const originalApiKey = process.env.DEEPSEEK_API_KEY;
afterEach(() => {
	if (originalApiKey === undefined) {
		delete process.env.DEEPSEEK_API_KEY;
	} else {
		process.env.DEEPSEEK_API_KEY = originalApiKey;
	}
});

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("DeepSeek web search", () => {
	it("posts to the documented search endpoint and maps results", async () => {
		process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
		let capturedUrl: string | undefined;
		let capturedAuth: string | null | undefined;
		let capturedBody: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (input, init) => {
			capturedUrl = String(input);
			capturedAuth = new Headers(init?.headers).get("Authorization");
			capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return jsonResponse({
				results: [
					{
						rerank_score: 2.4,
						title: "DeepSeek V4 model released",
						url: "https://example.com/deepseek-v4",
						snippet: "Short UI blurb.",
						summary: "The model-facing summary of the release.",
						content: "",
						site_name: "Example News",
						site_icon: null,
						date: "2026-06-01T00:00:00+00:00",
						authority: 3,
					},
					{ title: "", url: "https://example.com/two", snippet: "Only a snippet." },
					{ title: "No URL", url: "" },
				],
			});
		};

		const actual = await searchDeepSeek({
			query: "DeepSeek V4",
			num_results: 5,
			authStorage,
			fetch: fetchMock,
		});

		expect(capturedUrl).toBe("https://api.deepseek.com/v1/tools/search");
		expect(capturedAuth).toBe("Bearer test-deepseek-key");
		expect(capturedBody).toEqual({ query: "DeepSeek V4", count: 5, need_content: false });
		expect(actual.provider).toBe("deepseek");
		expect(actual.authMode).toBe("api_key");
		expect(actual.sources).toHaveLength(2);
		expect(actual.sources[0]).toMatchObject({
			title: "DeepSeek V4 model released",
			url: "https://example.com/deepseek-v4",
			snippet: "The model-facing summary of the release.",
			publishedDate: "2026-06-01T00:00:00+00:00",
			author: "Example News",
		});
		expect(actual.sources[0]?.ageSeconds).toBeNumber();
		// A blank title falls back to the URL; entries without a URL are dropped.
		expect(actual.sources[1]).toMatchObject({ title: "https://example.com/two", snippet: "Only a snippet." });
	});

	it("defaults count to 10 and clamps it to the documented 1-50 range", () => {
		const base = { query: "q", authStorage };

		expect(buildDeepSeekRequestBody(base).count).toBe(10);
		expect(buildDeepSeekRequestBody({ ...base, num_results: 3 }).count).toBe(3);
		expect(buildDeepSeekRequestBody({ ...base, num_results: 500 }).count).toBe(50);
	});

	it("maps recency onto an absolute publish-date bound and keeps the raw question", () => {
		const body = buildDeepSeekRequestBody({ query: "release notes", recency: "week", authStorage });
		const expectedSince = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

		expect(body.query).toBe(`release notes after:${expectedSince}`);
		expect(body.ori_question).toBe("release notes");
	});

	it("lets explicit before/after directives win over recency", () => {
		const body = buildDeepSeekRequestBody({
			query: "DeepSeek site:github.com after:2025-01-01",
			recency: "day",
			authStorage,
		});

		expect(body.query).toBe("DeepSeek site:github.com after:2025-01-01");
	});

	it("classifies a 401 as an authorization failure", async () => {
		process.env.DEEPSEEK_API_KEY = "bad-key";
		const fetchMock: FetchImpl = async () => new Response("unauthorized", { status: 401 });

		const failure = await searchDeepSeek({ query: "anything", authStorage, fetch: fetchMock }).catch(error => error);

		expect((failure as Error).message).toContain("401");
	});

	it("surfaces the documented OpenAI-style error message", async () => {
		process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
		const fetchMock: FetchImpl = async () =>
			jsonResponse({ error: { message: "'count' must be between 1 and 50" } }, 400);

		const failure = await searchDeepSeek({ query: "anything", num_results: 1, authStorage, fetch: fetchMock }).catch(
			error => error,
		);

		expect((failure as Error).message).toContain("'count' must be between 1 and 50");
		expect((failure as Error).message).toContain("400");
	});
});
