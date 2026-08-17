/**
 * web_search renderer tests: while the search runs (no response yet) the
 * card shows the aicss web-search shimmering query header with skeleton
 * sources; once the response lands it switches to the source list — the
 * placeholder never coexists with resolved sources.
 */
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolRenderProps } from "../src/tool-render/types";
import { webSearchRenderer } from "../src/tool-render/tools/web-search";

const renderBody = webSearchRenderer.Body as (props: ToolRenderProps) => ReactNode;

const ARGS = { query: "JWT auth vulnerabilities and middleware security best practices", limit: 5 };

function searchResult(answer?: string): ToolRenderProps["result"] {
	return {
		content: [{ type: "text", text: answer ?? "Synthesized answer." }],
		details: {
			response: {
				provider: "brave",
				model: "gpt-4o-mini",
				usage: { searchRequests: 1, inputTokens: 10, outputTokens: 20 },
				sources: [
					{ url: "https://auth0.com/blog/jwt-security-best-practices", title: "JWT verification best practices" },
					{ url: "https://owasp.org/www-project-nodejs-goat", title: "Node.js authentication security guide" },
				],
			},
		},
	};
}

describe("web_search renderer", () => {
	it("shows the shimmering search header with skeleton sources while running", () => {
		const html = renderToStaticMarkup(
			renderBody({ args: ARGS, result: undefined, running: true } as never),
		);
		expect(html).toContain("tr-search-placeholder");
		expect(html).toContain("tr-search-shimmer");
		expect(html).toContain("Searching");
		expect(html).toContain("JWT auth vulnerabilities");
		expect(html).toContain("tr-search-ph-source");
		// badges / kv table suppressed while searching
		expect(html).not.toContain("tv-kv");
		expect(html).not.toContain("tr-tool-search-row");
	});

	it("switches to the resolved source list once the response lands", () => {
		const html = renderToStaticMarkup(
			renderBody({ args: ARGS, result: searchResult(), running: false } as never),
		);
		expect(html).not.toContain("tr-search-placeholder");
		expect(html).toContain("tr-tool-search-row");
		expect(html).toContain("JWT verification best practices");
		expect(html).toContain("auth0.com");
		// dimmed URL line under the title
		expect(html).toContain("tr-tool-search-url");
	});

	it("renders [N] markers as superscript citations when the source exists", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: ARGS,
				result: searchResult("Transformers scale well [1], though attention is quadratic [2]."),
				running: false,
			} as never),
		);
		expect(html).toContain('<sup class="tr-cite">1</sup>');
		expect(html).toContain('<sup class="tr-cite">2</sup>');
	});

	it("leaves out-of-range markers as plain text (not citations)", () => {
		const html = renderToStaticMarkup(
			renderBody({
				args: ARGS,
				result: searchResult("No refs here, but a log line [42] and out-of-range [9]."),
				running: false,
			} as never),
		);
		expect(html).not.toContain('<sup class="tr-cite">');
		expect(html).toContain("[42]");
		expect(html).toContain("[9]");
	});

	it("numbers the source footer rows to match the markers", () => {
		const html = renderToStaticMarkup(
			renderBody({ args: ARGS, result: searchResult(), running: false } as never),
		);
		expect(html).toContain('<span class="tr-cite-n"');
		expect(html).toContain(">1</span>");
		expect(html).toContain(">2</span>");
	});
});
