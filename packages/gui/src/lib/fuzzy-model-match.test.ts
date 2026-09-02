import { matchesFuzzyQuery, matchesModelQuery } from "./fuzzy-model-match";

describe("matchesModelQuery", () => {
	it("matches everything on an empty query", () => {
		expect(matchesModelQuery("", "google", "gemini-2.5-pro", "Gemini 2.5 Pro")).toBe(true);
		expect(matchesModelQuery("  ", "openai", "gpt-4o", "GPT-4o")).toBe(true);
	});

	it("matches a subsequence inside a single field", () => {
		// "go" as subsequence of "google"
		expect(matchesModelQuery("go", "google", "gemini-2.5-pro", "Gemini 2.5 Pro")).toBe(true);
		// "ds" as subsequence of "deepseek-v4-flash"
		expect(matchesModelQuery("ds", "b-ai", "deepseek-v4-flash", "DeepSeek V4 Flash")).toBe(true);
		// contiguous substring still works
		expect(matchesModelQuery("deepseek", "b-ai", "deepseek-v4-flash", "DeepSeek V4 Flash")).toBe(true);
	});

	it("matches across concatenated fields (provider + id + name)", () => {
		// "google gemini" — first token in provider, second in id
		expect(matchesModelQuery("google gemini", "google", "gemini-2.5-pro", "Gemini 2.5 Pro")).toBe(true);
		// "b-ai deepseek" — provider prefix + id start
		expect(matchesModelQuery("b-ai deepseek", "b-ai", "deepseek-v4-flash", "DeepSeek V4 Flash")).toBe(true);
	});

	it("rejects when no token matches", () => {
		expect(matchesModelQuery("zzz", "google", "gemini-2.5-pro", "Gemini 2.5 Pro")).toBe(false);
	});

	it("rejects when one of multiple tokens fails", () => {
		expect(matchesModelQuery("google zzz", "google", "gemini-2.5-pro", "Gemini 2.5 Pro")).toBe(false);
	});

	it("handles alphanumeric-boundary queries (TUI swap parity via subsequence)", () => {
		// "gpt5" is a subsequence of "gpt-5.2" (g-p-t-5 in order)
		expect(matchesModelQuery("gpt5", "openai", "gpt-5.2", "GPT-5.2")).toBe(true);
		// "4o" is a subsequence of "gpt-4o" (4-o in order)
		expect(matchesModelQuery("4o", "openai", "gpt-4o", "GPT-4o")).toBe(true);
	});

	it("matches by provider name", () => {
		// "anthrop" as subsequence of "anthropic"
		expect(matchesModelQuery("anthrop", "anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6")).toBe(true);
		// "claude" in id
		expect(matchesModelQuery("claude", "anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.6")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(matchesModelQuery("DEEPSEEK", "b-ai", "deepseek-v4-flash", "DeepSeek V4 Flash")).toBe(true);
		expect(matchesModelQuery("Gemini", "google", "gemini-2.5-pro", "Gemini 2.5 Pro")).toBe(true);
	});
});

describe("matchesFuzzyQuery (session sidebar search)", () => {
	it("matches a label + cwd haystack with subsequence semantics", () => {
		// "ds" matches "DeepSeek 重构" — the exact gap the substring search missed.
		expect(matchesFuzzyQuery("ds", "DeepSeek 重构 C:/Users/unive/projects/app")).toBe(true);
		// path fragment via subsequence: "hgeng" in "harness-engineering"
		expect(matchesFuzzyQuery("hgeng", "refactor C:/Users/unive/projects/harness-engineering")).toBe(true);
	});

	it("requires every whitespace token to match the combined haystack", () => {
		// first token in the label, second in the cwd — same all-tokens
		// contract the model picker applies to provider/id/name.
		expect(matchesFuzzyQuery("重构 projects", "DeepSeek 重构 C:/Users/unive/projects/app")).toBe(true);
		expect(matchesFuzzyQuery("重构 zzz", "DeepSeek 重构 C:/Users/unive/projects/app")).toBe(false);
	});
});
