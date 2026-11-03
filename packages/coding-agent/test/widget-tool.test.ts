import { describe, expect, test } from "bun:test";
import { WidgetTool } from "../src/bundled-plugins/visuals/tool";

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

	test("accepts a type contributed by a loaded extension", async () => {
		const r = await tool.execute("c5", { type: "probe", data: { value: 7 } } as never, undefined, undefined, {
			getRegisteredWidgets: () => [
				{
					type: "probe",
					label: "Probe",
					fields: [{ key: "value", type: "number" }],
					defaults: () => ({ value: 1 }),
					moduleUrl: "./probe.tsx",
				},
			],
		} as never);
		expect(r.isError).not.toBe(true);
		expect(r.details).toMatchObject({ type: "probe", data: { value: 7 } });
	});

	test("rejects the same type when no extension contributes it", async () => {
		const r = await tool.execute("c6", { type: "probe" } as never);
		expect(r.isError).toBe(true);
	});
});
