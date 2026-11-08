/**
 * The `musepi-visuals` bundled plugin owns the `widget` tool.
 *
 * It used to be a built-in factory gated inside `createTools`. Moving it to a
 * plugin must keep two facts: the plugin registers the tool (otherwise every
 * session loses it), and the definition carries the `widget.enabled` switch
 * (otherwise a presentation surface becomes impossible to turn off).
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionWidget, ToolDefinition } from "../../extensibility/extensions/types";
import { apply } from "./index";

function fakeCtx(): { ctx: ExtensionAPI; tools: ToolDefinition[]; widgets: ExtensionWidget[] } {
	const tools: ToolDefinition[] = [];
	const widgets: ExtensionWidget[] = [];
	const ctx = {
		setLabel() {},
		tools: {
			register(tool: ToolDefinition) {
				tools.push(tool);
			},
		},
		slots: {
			registerWidget(widget: ExtensionWidget) {
				widgets.push(widget);
			},
		},
		logger: { info() {}, warn() {}, error() {} },
	} as unknown as ExtensionAPI;
	return { ctx, tools, widgets };
}

describe("musepi-visuals plugin", () => {
	test("registers the widget tool", () => {
		const { ctx, tools } = fakeCtx();
		apply(ctx);
		expect(tools.map(tool => tool.name)).toEqual(["widget"]);
	});

	test("registers both plugin widget types through the seam", () => {
		const { ctx, widgets } = fakeCtx();
		apply(ctx);
		expect(widgets.map(widget => widget.type)).toEqual(["metric", "clock"]);
		expect(widgets.find(widget => widget.type === "metric")?.moduleUrl).toBe("./ui/metric.tsx");
		expect(widgets.find(widget => widget.type === "clock")?.defaults()).toEqual({ market: "cn" });
	});

	test("honours widget.enabled through the definition gate", () => {
		const { ctx, tools } = fakeCtx();
		apply(ctx);
		const widget = tools[0]!;
		expect(widget.enabled?.({ settings: { get: () => true } })).toBe(true);
		expect(widget.enabled?.({ settings: { get: () => false } })).toBe(false);
		// A missing value must not hide the tool: only an explicit false does.
		expect(widget.enabled?.({ settings: { get: () => undefined } })).toBe(true);
	});
});
