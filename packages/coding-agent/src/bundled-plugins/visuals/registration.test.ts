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

function fakePi(): { pi: ExtensionAPI; tools: ToolDefinition[]; widgets: ExtensionWidget[] } {
	const tools: ToolDefinition[] = [];
	const widgets: ExtensionWidget[] = [];
	const pi = {
		setLabel() {},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		registerWidget(widget: ExtensionWidget) {
			widgets.push(widget);
		},
		logger: { info() {}, warn() {}, error() {} },
	} as unknown as ExtensionAPI;
	return { pi, tools, widgets };
}

describe("musepi-visuals plugin", () => {
	test("registers the widget tool", () => {
		const { pi, tools } = fakePi();
		apply(pi);
		expect(tools.map(tool => tool.name)).toEqual(["widget"]);
	});

	test("registers the metric widget type through the seam", () => {
		const { pi, widgets } = fakePi();
		apply(pi);
		expect(widgets.map(widget => widget.type)).toEqual(["metric"]);
		expect(widgets[0]?.moduleUrl).toBe("./ui/metric.tsx");
		expect(widgets[0]?.defaults()).toMatchObject({ value: 4200 });
	});

	test("honours widget.enabled through the definition gate", () => {
		const { pi, tools } = fakePi();
		apply(pi);
		const widget = tools[0]!;
		expect(widget.enabled?.({ settings: { get: () => true } })).toBe(true);
		expect(widget.enabled?.({ settings: { get: () => false } })).toBe(false);
		// A missing value must not hide the tool: only an explicit false does.
		expect(widget.enabled?.({ settings: { get: () => undefined } })).toBe(true);
	});
});
