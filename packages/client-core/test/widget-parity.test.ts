/**
 * Registry parity: the daemon's agent-facing WIDGET_TYPES table must stay
 * in sync with the GUI's shared widget registry (it drifted once — video
 * was missing, so agents couldn't render a widget the board offered).
 */
import { describe, expect, test } from "bun:test";
// Test-only cross-package import: WIDGET_TYPES lives in the daemon tool.
// eslint-disable-next-line import/no-relative-parent-imports
import { WIDGET_TONES, WIDGET_TYPES } from "../../coding-agent/src/bundled-plugins/visuals/tool";
import { CLOCK_WIDGET } from "../../coding-agent/src/bundled-plugins/visuals/widgets/clock";
import { METRIC_WIDGET } from "../../coding-agent/src/bundled-plugins/visuals/widgets/metric";
import { WIDGET_REGISTRY } from "../src/widgets/registry";

describe("widget registry ↔ WIDGET_TYPES parity", () => {
	test("every registry type exists in the daemon table", () => {
		// The daemon table may also hold plugin-contributed types (registerWidget)
		// such as `metric`, which no longer live in the static client registry.
		const daemonTypes = new Set(Object.keys(WIDGET_TYPES));
		for (const def of WIDGET_REGISTRY) expect(daemonTypes.has(def.type), def.type).toBe(true);
	});

	test("plugin-contributed metadata agrees with the daemon table", () => {
		for (const widget of [METRIC_WIDGET, CLOCK_WIDGET]) {
			expect(WIDGET_TYPES[widget.type], widget.type).toBeDefined();
			expect(WIDGET_TYPES[widget.type].fields.map(f => f.key)).toEqual(widget.fields.map(f => f.key));
			expect(WIDGET_TYPES[widget.type].defaults).toEqual(widget.defaults());
			expect(WIDGET_TONES[widget.type]).toBe(widget.tone ?? "default");
		}
	});

	test("defaults agree per type", () => {
		for (const def of WIDGET_REGISTRY) {
			const expected = def.defaults();
			const daemon = WIDGET_TYPES[def.type].defaults;
			for (const [k, v] of Object.entries(expected)) {
				// pomodoro.day is a dynamic date string and kline.candles is
				// a generated sample series — the daemon table can't hold a
				// static equal value for either.
				if (k === "day" || (def.type === "kline" && k === "candles")) {
					expect(typeof daemon[k], `${def.type}.${k}`).toBe(typeof v);
					continue;
				}
				expect(daemon[k], `${def.type}.${k}`).toEqual(v);
			}
		}
	});

	test("tones agree per type", () => {
		for (const def of WIDGET_REGISTRY) {
			expect(WIDGET_TONES[def.type], def.type).toBe(def.tone ?? "default");
		}
	});

	test("fields agree per type", () => {
		for (const def of WIDGET_REGISTRY) {
			const expectedKeys = def.fields.map(f => f.key).sort();
			const daemonKeys = WIDGET_TYPES[def.type].fields.map(f => f.key).sort();
			expect(daemonKeys, def.type).toEqual(expectedKeys);
		}
	});
});
