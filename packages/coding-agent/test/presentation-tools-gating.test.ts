import { describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@musepi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@musepi/pi-coding-agent/tools";
import { WidgetTool } from "../src/bundled-plugins/visuals/tool";
import type { RegisteredTool, ToolDefinition } from "../src/extensibility/extensions/types";
import { isRegisteredToolEnabled } from "../src/tools/registered-tool-gate";

/**
 * Presentation-tool gating (`widget`, `board`).
 *
 * `widget` moved to the bundled `musepi-visuals` plugin, so it is no longer a
 * built-in factory: the model sees it because the plugin registers it, and
 * the `widget.enabled` switch rides the tool definition's `enabled` predicate
 * (consulted by `isRegisteredToolEnabled` where sessions assemble their
 * registered tools). `board` still gates in `createTools`. Both contracts are
 * observable in the tool list the model receives.
 */
function makeSession(settingsOverrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		skipPythonPreflight: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(settingsOverrides),
	};
}

async function toolNames(overrides: Partial<Record<SettingPath, unknown>> = {}): Promise<string[]> {
	return (await createTools(makeSession(overrides))).map(tool => tool.name);
}

function registeredWidget(): RegisteredTool {
	return {
		definition: new WidgetTool() as unknown as ToolDefinition,
		extensionPath: "<builtin:musepi-visuals>",
	};
}

describe("presentation tool gating", () => {
	it("offers board by default", async () => {
		expect(await toolNames()).toContain("board");
	});

	it("drops board when its setting is off, leaving the rest alone", async () => {
		const names = await toolNames({ "board.enabled": false });
		expect(names).not.toContain("board");
		expect(names).toContain("read");
		expect(names).toContain("bash");
	});

	it("keeps widget out of the built-in slate — it is a plugin tool", async () => {
		const names = await toolNames();
		expect(names).not.toContain("widget");
		expect(names.length).toBeGreaterThan(5);
	});

	it("keeps the registered widget while its switch is on", () => {
		expect(isRegisteredToolEnabled(registeredWidget(), Settings.isolated({}))).toBe(true);
	});

	it("drops the registered widget when its switch is off", () => {
		expect(isRegisteredToolEnabled(registeredWidget(), Settings.isolated({ "widget.enabled": false }))).toBe(false);
	});

	it("drops a registered tool named in the user's denylist", () => {
		// Presets narrow the slate through `tools.disabled`; a plugin tool must
		// honour the same list or a minimal preset would still show widget.
		expect(isRegisteredToolEnabled(registeredWidget(), Settings.isolated({ "tools.disabled": ["widget"] }))).toBe(
			false,
		);
	});

	it("leaves other registered tools alone", () => {
		expect(isRegisteredToolEnabled(registeredWidget(), Settings.isolated({ "tools.disabled": ["bash"] }))).toBe(true);
	});
});
