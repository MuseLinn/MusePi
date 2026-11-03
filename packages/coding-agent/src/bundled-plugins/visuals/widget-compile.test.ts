/**
 * End-to-end guard for the registerWidget renderer pipeline.
 *
 * `collectWidgetViews` is what `extensions.list` serves: it loads the plugin,
 * reads its widget declarations, compiles each `moduleUrl`, and ships the code.
 * A renderer that imports React directly, references a host module that is not
 * exported, or fails to compile would silently leave the card unavailable in
 * the GUI — this test fails instead.
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { PLUGIN_MODULE_KIND } from "../../capability/extension-module";
import { collectWidgetViews } from "../../daemon/extension-artifact-compiler";

const entry = path.join(import.meta.dir, "index.ts");

describe("visuals plugin widget renderers", () => {
	test("compiles every registered widget type into a host-React module", async () => {
		const views = await collectWidgetViews(
			[{ kind: PLUGIN_MODULE_KIND, state: "active", path: entry }],
			process.cwd(),
		);
		expect(views.map(view => view.type).sort()).toEqual(["clock", "metric"]);
		for (const view of views) {
			expect(view.error, view.type).toBeUndefined();
			expect(view.code.length, view.type).toBeGreaterThan(0);
			// React must come from the host, not a bundled copy.
			expect(view.code).toContain("MusePiReact");
			expect(view.code).not.toMatch(/require\(["']react["']\)/);
		}
	});
});
