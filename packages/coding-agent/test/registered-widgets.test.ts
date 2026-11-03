/**
 * The process-level widget index is what session-less RPCs (`board.save`,
 * `widget.schema`) validate against. `registerWidget` must populate it and an
 * unload must remove the entry; the merged table is the same one the tools
 * build from their context.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { widgetTypesWith } from "../src/bundled-plugins/visuals/tool";
import {
	forgetRegisteredWidget,
	getRegisteredWidgets,
	rememberRegisteredWidget,
	resetRegisteredWidgets,
} from "../src/daemon/registered-widgets";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { EventBus } from "../src/utils/event-bus";

const PROBE = {
	type: "probe",
	label: "Probe",
	fields: [{ key: "value", type: "number" as const }],
	defaults: () => ({ value: 3 }),
	moduleUrl: "./probe.tsx",
};

afterEach(() => resetRegisteredWidgets());

describe("registered widget index", () => {
	test("merges into the daemon type table", () => {
		rememberRegisteredWidget(PROBE);
		expect(widgetTypesWith(getRegisteredWidgets()).probe).toEqual({
			fields: [{ key: "value", type: "number" }],
			defaults: { value: 3 },
		});
		forgetRegisteredWidget("probe");
		expect(widgetTypesWith(getRegisteredWidgets()).probe).toBeUndefined();
	});

	test("registerWidget writes the index through the real loader", async () => {
		await loadExtensionFromFactory(
			pi => {
				pi.registerWidget(PROBE);
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
			"widget-index-probe.ts",
		);
		expect(getRegisteredWidgets().map(widget => widget.type)).toEqual(["probe"]);
	});
});
