/**
 * `widget` tool — inline widget renderer: validates the type against the
 * shared registry table, merges defaults into data, and returns a details
 * payload for the GUI tool-render pipeline.
 */
import { describe, expect, test } from "bun:test";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
import { WidgetTool } from "../../src/tools/widget";

describe("widget tool", () => {
	test("renders a calc widget with merged defaults", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { type: "calc", data: { amount: 2000 } });
		expect(res.isError).not.toBe(true);
		expect(res.details).toEqual({ action: "card", type: "calc", data: { mode: "post", amount: 2000 } });
		expect(res.content[0].type).toBe("text");
	});

	test("rejects unknown types with the available list", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { type: "nope" });
		expect(res.isError).toBe(true);
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("unknown type");
		expect(text).toContain("calc");
	});

	test("carries an optional title", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { type: "ticker", title: "EUR" });
		expect(res.details?.title).toBe("EUR");
		expect(res.details?.data).toHaveProperty("label", "EUR / CNY");
	});

	test("pomodoro type is known with mode default", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { type: "pomodoro", data: { mode: "short" } });
		expect(res.isError).not.toBe(true);
		expect(res.details?.data).toMatchObject({ mode: "short", rounds: 0 });
	});

	test("empty data falls back to the type defaults", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { type: "metric" });
		expect(res.details?.data).toMatchObject({ value: 4200, delta: 0.12 });
	});
});

describe("widget page action", () => {
	const page = "<!doctype html><html><body><h1>Compare</h1></body></html>";

	test("renders a page as the html widget's face, not a second implementation", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { action: "page", title: "Compare two plans", html: page });
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
		const res = await tool.execute("c1", { action: "page", html: page });
		const text = res.content[0].type === "text" ? res.content[0].text : "";
		expect(text).toContain("Don't announce, describe or restate the page");
	});

	test("collects local image paths the chat must inline", async () => {
		// A sandboxed page cannot read the filesystem; the host swaps each path
		// for the file's contents.
		const tool = new WidgetTool();
		const res = await tool.execute("c1", {
			action: "page",
			html: `<img src="C:\\shots\\a.png"><div style="background:url('/tmp/b.jpg')"></div>`,
		});
		expect(res.details?.images).toEqual(["C:\\shots\\a.png", "/tmp/b.jpg"]);
	});

	test("rejects empty html, and html over the renderer's own cap", async () => {
		const tool = new WidgetTool();
		const blank = await tool.execute("c1", { action: "page", html: "   " });
		expect(blank.isError).toBe(true);
		expect(blank.content[0].type === "text" ? blank.content[0].text : "").toContain("html is required");

		// The cap is the renderer's MAX_HTML, not a number invented here: a page
		// over it renders as an "oversize" notice, so accepting more would only
		// defer the failure to the client.
		const huge = "x".repeat(MAX_WIDGET_HTML + 1);
		const over = await tool.execute("c1", { action: "page", html: huge });
		expect(over.isError).toBe(true);
		expect(over.content[0].type === "text" ? over.content[0].text : "").toContain(String(MAX_WIDGET_HTML));

		// And exactly at the cap still renders.
		const edge = await tool.execute("c1", { action: "page", html: "x".repeat(MAX_WIDGET_HTML) });
		expect(edge.isError).not.toBe(true);
	});

	test("rejects a title over the cap so a heading stays a heading", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { action: "page", html: page, title: "t".repeat(200) });
		expect(res.isError).toBe(true);
		expect(res.content[0].type === "text" ? res.content[0].text : "").toContain("title exceeds");
	});

	test("still rejects an unknown card type, so the action never becomes a bypass", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { type: "nope" });
		expect(res.isError).toBe(true);
		expect(res.content[0].type === "text" ? res.content[0].text : "").toContain("unknown type");
	});
});
