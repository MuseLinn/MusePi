import { describe, expect, test } from "bun:test";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
import { RENDER_PAGE_MAX_LOCAL_IMAGES, WidgetTool } from "../src/bundled-plugins/visuals/tool";

const tool = new WidgetTool();
const text = (r: { content?: { type: string; text?: string }[] }): string =>
	r.content?.find(part => part.type === "text")?.text ?? "";

describe("widget tool (page)", () => {
	test("requires a non-empty html document", async () => {
		const r = await tool.execute("c1", {} as never);
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("html is required");
	});

	test("rejects an oversize page before it reaches the transcript", async () => {
		const r = await tool.execute("c2", { html: `x${"y".repeat(MAX_WIDGET_HTML)}` } as never);
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("exceeds");
	});

	test("rejects a title that reads as a paragraph", async () => {
		const r = await tool.execute("c3", { html: "<p>ok</p>", title: "长".repeat(121) } as never);
		expect(r.isError).toBe(true);
		expect(text(r)).toContain("title exceeds");
	});

	test("returns the page as the html widget's face with the given title", async () => {
		const r = await tool.execute("c4", { html: "<p>行情</p>", title: "今日行情" } as never);
		expect(r.isError).not.toBe(true);
		expect(r.details).toMatchObject({
			action: "page",
			type: "html",
			title: "今日行情",
			data: { html: "<p>行情</p>" },
		});
		expect(r.details?.html).toBe("<p>行情</p>");
	});

	test("collects local image references in order and caps them", async () => {
		const html = Array.from({ length: 14 }, (_, index) => `<img src="/tmp/shot-${index}.png">`).join("");
		const r = await tool.execute("c5", { html } as never);
		expect(r.details?.images).toHaveLength(RENDER_PAGE_MAX_LOCAL_IMAGES);
		expect(r.details?.images?.[0]).toBe("/tmp/shot-0.png");
	});

	test("carries awaitAnswer only when the page asks for a choice", async () => {
		const asked = await tool.execute("c6", { html: "<p>选一个</p>", awaitAnswer: true } as never);
		expect(asked.details?.awaitAnswer).toBe(true);
		const plain = await tool.execute("c7", { html: "<p>只是展示</p>" } as never);
		expect(plain.details?.awaitAnswer).toBeUndefined();
	});
});
