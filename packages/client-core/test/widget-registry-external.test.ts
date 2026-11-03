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
		expect(types).toContain("gauge");
	});

	it("lets a plugin override a built-in type", () => {
		registerExternalWidgets([external({ type: "gauge", label: "Plugin gauge" })]);
		expect(widgetDef("gauge")?.label).toBe("Plugin gauge");
		// No duplicate row in the merged list.
		expect(widgetDefs().filter(def => def.type === "gauge")).toHaveLength(1);
	});

	it("restores the built-ins when the external set is cleared", () => {
		registerExternalWidgets([external()]);
		registerExternalWidgets([]);
		expect(widgetDef("metric")).toBeUndefined();
		expect(widgetDef("gauge")?.nameKey).toBe("widget gauge");
	});
});
