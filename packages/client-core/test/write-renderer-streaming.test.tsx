import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeRenderer } from "../src/tool-render/tools/write";
import type { ToolRenderProps } from "../src/tool-render/types";

/**
 * A write call streams its arguments: `content` arrives in chunks, so for most
 * of the call's life the renderer sees a path and no content — or neither.
 *
 * Reporting that as `[invalid content] — expected string` reads as a tool
 * failure the user did not cause and cannot act on; a write in progress looked
 * like a broken write. The same args after the call FINISHES are genuinely
 * malformed and must still be reported, so the two states have to be
 * distinguishable — `running` is what distinguishes them.
 */

function render(props: Partial<ToolRenderProps>): string {
	const Body = writeRenderer.Body;
	if (!Body) throw new Error("write renderer has no Body");
	return renderToStaticMarkup((<Body name="write" args={{}} {...props} />) as ReactNode);
}

function renderSummary(props: Partial<ToolRenderProps>): string {
	const Summary = writeRenderer.Summary;
	return renderToStaticMarkup((<Summary name="write" args={{}} {...props} />) as ReactNode);
}

describe("write renderer while arguments stream", () => {
	it("says the content is still coming, not that it is invalid", () => {
		const html = render({ args: { file_path: "/tmp/a.ts" }, running: true });
		expect(html).not.toContain("invalid");
		expect(html).toContain("tv-note");
		expect(html).not.toContain("tv-err-text");
	});

	it("does not fault a missing path mid-stream", () => {
		// The path is the first field but can still be absent on the first frame.
		const html = renderSummary({ args: {}, running: true });
		expect(html).not.toContain("invalid");
	});

	it("renders the content once it arrives, still running", () => {
		const html = render({ args: { file_path: "/tmp/a.ts", content: "const a = 1;\n" }, running: true });
		expect(html).not.toContain("invalid");
		expect(html).not.toContain("tv-note");
		expect(html).toContain("const a = 1;");
	});
});

describe("write renderer after the call settles", () => {
	it("reports genuinely malformed args", () => {
		// A finished call with no content is a real fault: the badge is the only
		// signal the user gets that the tool call itself was wrong.
		const html = render({ args: { file_path: "/tmp/a.ts" }, running: false });
		expect(html).toContain("invalid");
	});

	it("reports a missing path too", () => {
		const html = renderSummary({ args: {}, running: false });
		expect(html).toContain("invalid");
	});
});
