import "./transcript-dom-shim";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { webSearchRenderer } from "../src/tool-render/tools/web-search";
import type { ToolRenderHost, ToolRenderProps } from "../src/tool-render/types";

/**
 * `web_search` failure rendering: a provider-chain failure must surface as a
 * structured error card (localized title + detail + optional settings jump)
 * with the provider's display label — never as the raw `Error: …` content
 * text, which is model food, and never as the lowercase config id.
 */
function errorProps(host?: ToolRenderHost): ToolRenderProps {
	return {
		name: "web_search",
		args: { query: "amaranth germination days" },
		result: {
			content: [{ type: "text", text: "Error: All web search providers failed: mojeek: boom" }],
			details: {
				response: { provider: "mojeek", sources: [] },
				error: "All web search providers failed: mojeek: boom",
				providerLabel: "Mojeek",
			},
		},
		host,
	};
}

const Body = webSearchRenderer.Body;
if (!Body) throw new Error("web_search renderer has no Body");

describe("web_search renderer error card", () => {
	it("renders a structured error note instead of the raw Error: dump", () => {
		const html = renderToStaticMarkup(<Body {...errorProps()} />);
		expect(html).toContain("tv-note--err");
		expect(html).toContain("All web search providers failed");
		// The raw content text carries the `Error: ` prefix; the structured
		// card shows the detail without re-dumping the content block.
		expect(html).not.toContain("Error: All web search providers failed");
	});

	it("shows the provider display label, not the raw config id", () => {
		const html = renderToStaticMarkup(<Body {...errorProps()} />);
		expect(html).toContain("Mojeek");
	});

	it("offers a settings jump only when the host owns a settings surface", () => {
		const withHost = renderToStaticMarkup(<Body {...errorProps({ openSettings: () => {} })} />);
		expect(withHost).toContain("tv-board-open");
		const withoutHost = renderToStaticMarkup(<Body {...errorProps()} />);
		expect(withoutHost).not.toContain("tv-board-open");
	});
});
