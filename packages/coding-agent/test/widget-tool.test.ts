import { describe, expect, test } from "bun:test";
import { WidgetTool } from "../src/tools/widget";

const tool = new WidgetTool();

describe("widget tool validation", () => {
	test("rejects unknown widget types with the available list", async () => {
		const r = await tool.execute("c1", { type: "no-such" } as never);
		const first = r.content?.[0];
		const text = first && "text" in first ? String(first.text) : "";
		expect(r.isError).toBe(true);
		expect(text).toContain("unknown type");
		expect(text).toContain("clock");
	});

	test("accepts a known type and merges defaults into data", async () => {
		const r = await tool.execute("c2", { type: "calc" } as never);
		expect(r.isError).not.toBe(true);
		const details = r.details as { type: string; data: Record<string, unknown> };
		expect(details.type).toBe("calc");
		// defaults merged even with no data supplied
		expect(details.data).toBeDefined();
	});

	test("rejects oversized data payloads", async () => {
		const r = await tool.execute("c3", { type: "html", data: { html: "x".repeat(70_000) } } as never);
		const first = r.content?.[0];
		const text = first && "text" in first ? String(first.text) : "";
		expect(r.isError).toBe(true);
		expect(text).toContain("exceeds");
	});

	test("keeps the agent title when provided", async () => {
		const r = await tool.execute("c4", { type: "clock", title: "我的时钟" } as never);
		expect(r.details).toMatchObject({ title: "我的时钟" });
	});
});
