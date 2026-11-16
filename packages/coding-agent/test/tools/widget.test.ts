/**
 * `widget` tool — draws one self-contained HTML page inline in the reply.
 *
 * The structured card types are no longer part of this tool: data belongs in a
 * UI block (see packages/client-core/src/ui-blocks), and the canned card
 * registry now belongs to the board, where a card persists on a canvas.
 */
import { describe, expect, test } from "bun:test";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
import { WidgetTool } from "../../src/bundled-plugins/visuals/tool";

const page = "<!doctype html><html><body><h1>Compare</h1></body></html>";

describe("widget tool", () => {
	test("renders a page on the html widget's own face", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { title: "Compare two plans", html: page });
		expect(res.isError).not.toBe(true);
		// The renderer already owns the sandbox, the answer handback and the
		// theme tokens for `html`; a page must land on that same face so those
		// come for free instead of being re-built.
		expect(res.details?.action).toBe("page");
		expect(res.details?.type).toBe("html");
		expect(res.details?.data).toEqual({ html: page });
		expect(res.details?.title).toBe("Compare two plans");
	});

	test("tells the caller the page is already on screen", async () => {
		// Without this the model repeats the page's content in prose, which is
		// what a page exists to avoid.
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { html: page });
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("Don't announce, describe or restate the page");
	});

	test("collects local image paths the chat must inline", async () => {
		// A sandboxed page cannot read the filesystem; the host swaps each path
		// for the file's contents.
		const tool = new WidgetTool();
		const res = await tool.execute("c1", {
			html: `<img src="C:\\shots\\a.png"><div style="background:url('/tmp/b.jpg')"></div>`,
		});
		expect(res.details?.images).toEqual(["C:\\shots\\a.png", "/tmp/b.jpg"]);
	});

	test("rejects empty html, and html over the renderer's own cap", async () => {
		const tool = new WidgetTool();
		const blank = await tool.execute("c1", { html: "   " });
		expect(blank.isError).toBe(true);
		expect(blank.content[0].type === "text" ? blank.content[0].text : "").toContain("html is required");

		// The cap is the renderer's MAX_HTML, not a number invented here: a page
		// over it renders as an "oversize" notice, so accepting more would only
		// defer the failure to the client.
		const over = await tool.execute("c1", { html: "x".repeat(MAX_WIDGET_HTML + 1) });
		expect(over.isError).toBe(true);
		expect(over.content[0].type === "text" ? over.content[0].text : "").toContain(String(MAX_WIDGET_HTML));

		// And exactly at the cap still renders.
		const edge = await tool.execute("c1", { html: "x".repeat(MAX_WIDGET_HTML) });
		expect(edge.isError).not.toBe(true);
	});

	test("rejects a title over the cap so a heading stays a heading", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { html: page, title: "t".repeat(200) });
		expect(res.isError).toBe(true);
		expect(res.content[0].type === "text" ? res.content[0].text : "").toContain("title exceeds");
	});

	test("a call without html is refused, so a page is never implied", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { title: "只有标题" });
		expect(res.isError).toBe(true);
		expect(res.content[0].type === "text" ? res.content[0].text : "").toContain("html is required");
	});

	test("waiting for an answer is carried through to the chat", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { html: page, awaitAnswer: true });
		expect(res.details?.awaitAnswer).toBe(true);
	});
});
