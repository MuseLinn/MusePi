/**
 * Registry parity: the daemon's card table must stay in sync with the GUI's
 * widget registry. They drifted once (a type the board offered was missing
 * from the daemon table, so an agent could not create it).
 */
import { describe, expect, test } from "bun:test";
// Test-only cross-package import: WIDGET_TYPES lives in the daemon tool.
// eslint-disable-next-line import/no-relative-parent-imports
import { WIDGET_TONES, WIDGET_TYPES } from "../../coding-agent/src/bundled-plugins/board/catalog";
import { WIDGET_REGISTRY } from "../src/widgets/registry";

describe("widget registry ↔ WIDGET_TYPES parity", () => {
	test("both sides hold exactly the generated faces", () => {
		expect([...Object.keys(WIDGET_TYPES)].sort()).toEqual(["block", "html"]);
		expect(WIDGET_REGISTRY.map(def => def.type).sort()).toEqual(["block", "html"]);
	});

	test("every registry type exists in the daemon table", () => {
		const daemonTypes = new Set(Object.keys(WIDGET_TYPES));
		for (const def of WIDGET_REGISTRY) expect(daemonTypes.has(def.type), def.type).toBe(true);
	});

	test("fields and tones agree per type", () => {
		for (const def of WIDGET_REGISTRY) {
			expect(WIDGET_TYPES[def.type]?.fields.map(field => field.key)).toEqual(def.fields.map(field => field.key));
			expect(WIDGET_TONES[def.type]).toBe(def.tone ?? "default");
		}
	});
});
