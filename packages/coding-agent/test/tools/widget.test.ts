/**
 * `widget` tool — inline widget renderer: validates the type against the
 * shared registry table, merges defaults into data, and returns a details
 * payload for the GUI tool-render pipeline.
 */
import { describe, expect, test } from "bun:test";
import { WidgetTool } from "../../src/tools/widget";

describe("widget tool", () => {
	test("renders a calc widget with merged defaults", async () => {
		const tool = new WidgetTool();
		const res = await tool.execute("c1", { type: "calc", data: { amount: 2000 } });
		expect(res.isError).not.toBe(true);
		expect(res.details).toEqual({ type: "calc", data: { mode: "post", amount: 2000 } });
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
