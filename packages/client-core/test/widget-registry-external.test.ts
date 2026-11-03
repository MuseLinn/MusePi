/**
 * Plugin-contributed widget types (registerWidget) join the built-in registry
 * at runtime: lookups see them, the picker lists them, and clearing the set
 * (plugin disabled, daemon without the field) restores the built-ins.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { WidgetDef } from "../src/widgets/registry";
import { registerExternalWidgets, widgetDef, widgetDefs } from "../src/widgets/registry";

function external(overrides: Partial<WidgetDef> = {}): WidgetDef {
	return {
		type: "metric",
		label: "指标",
		fields: [{ key: "value", type: "number", label: "数值" }],
		defaults: () => ({ value: 42 }),
		Component: () => null,
		...overrides,
	};
}

afterEach(() => registerExternalWidgets([]));

describe("external widget registry", () => {
	it("resolves a plugin type by key and lists it beside built-ins", () => {
		registerExternalWidgets([external()]);
		expect(widgetDef("metric")?.label).toBe("指标");
		const types = widgetDefs().map(def => def.type);
		expect(types).toContain("metric");
		expect(types).toContain("clock");
	});

	it("lets a plugin override a built-in type", () => {
		registerExternalWidgets([external({ type: "clock", label: "Plugin clock" })]);
		expect(widgetDef("clock")?.label).toBe("Plugin clock");
		// No duplicate row in the merged list.
		expect(widgetDefs().filter(def => def.type === "clock")).toHaveLength(1);
	});

	it("restores the built-ins when the external set is cleared", () => {
		registerExternalWidgets([external()]);
		registerExternalWidgets([]);
		expect(widgetDef("metric")).toBeUndefined();
		expect(widgetDef("clock")?.nameKey).toBe("widget clock");
	});
});
