/**
 * The `musepi-visuals` bundled plugin owns the `widget` tool.
 *
 * It used to be a built-in factory gated inside `createTools`. Moving it to a
 * plugin must keep two facts: the plugin registers the tool (otherwise every
 * session loses it), and the definition carries the `widget.enabled` switch
 * (otherwise a presentation surface becomes impossible to turn off).
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "../../extensibility/extensions/types";
import { apply } from "./index";

function fakePi(): { pi: ExtensionAPI; tools: ToolDefinition[] } {
	const tools: ToolDefinition[] = [];
	const pi = {
		setLabel() {},
		registerTool(tool: ToolDefinition) {
			tools.push(tool);
		},
		logger: { info() {}, warn() {}, error() {} },
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

describe("musepi-visuals plugin", () => {
	test("registers the widget tool", () => {
		const { pi, tools } = fakePi();
		apply(pi);
		expect(tools.map(tool => tool.name)).toEqual(["widget"]);
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
