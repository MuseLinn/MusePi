import { describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@musepi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@musepi/pi-coding-agent/tools";
import { BoardTool } from "../src/bundled-plugins/board/tool";
import { WidgetTool } from "../src/bundled-plugins/visuals/tool";
import type { RegisteredTool, ToolDefinition } from "../src/extensibility/extensions/types";
import { isRegisteredToolEnabled } from "../src/tools/registered-tool-gate";

/**
 * Presentation-tool gating (`widget`, `board`).
 *
 * Both moved to bundled plugins, so they are no longer built-in factories: the
 * model sees them because the plugin registers them, and their switches
 * (`widget.enabled`, `board.enabled`) ride the tool definition's `enabled`
 * predicate — consulted by `isRegisteredToolEnabled` where sessions assemble
 * their registered tools. The observable contract is still the tool list the
 * model receives.
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

function registered(tool: ToolDefinition, path: string): RegisteredTool {
	return { definition: tool, extensionPath: path };
}

describe("presentation tool gating", () => {
	it("keeps both presentation tools out of the built-in slate", async () => {
		const names = await toolNames();
		expect(names).not.toContain("widget");
		expect(names).not.toContain("board");
		expect(names).toContain("read");
		expect(names.length).toBeGreaterThan(5);
	});

	it("keeps the registered widget while its switch is on", () => {
		expect(isRegisteredToolEnabled(registered(new WidgetTool() as never, "<visuals>"), Settings.isolated({}))).toBe(
			true,
		);
	});

	it("drops the registered widget when its switch is off", () => {
		expect(
			isRegisteredToolEnabled(
				registered(new WidgetTool() as never, "<visuals>"),
				Settings.isolated({ "widget.enabled": false }),
			),
		).toBe(false);
	});

	it("drops the registered board when its switch is off", () => {
		expect(
			isRegisteredToolEnabled(
				registered(new BoardTool() as never, "<board>"),
				Settings.isolated({ "board.enabled": false }),
			),
		).toBe(false);
	});

	it("drops a registered tool named in the user's denylist", () => {
		// Presets narrow the slate through `tools.disabled`; a plugin tool must
		// honour the same list or a minimal preset would still show it.
		expect(
			isRegisteredToolEnabled(
				registered(new WidgetTool() as never, "<visuals>"),
				Settings.isolated({
					"tools.disabled": ["widget"],
				}),
			),
		).toBe(false);
	});

	it("leaves other registered tools alone", () => {
		expect(
			isRegisteredToolEnabled(
				registered(new WidgetTool() as never, "<visuals>"),
				Settings.isolated({
					"tools.disabled": ["bash"],
				}),
			),
		).toBe(true);
	});

	it("keeps the board gate independent from the widget gate", () => {
		const board = registered(new BoardTool() as never, "<board>");
		const widget = registered(new WidgetTool() as never, "<visuals>");
		const settings = Settings.isolated({ "board.enabled": false });
		expect(isRegisteredToolEnabled(board, settings)).toBe(false);
		expect(isRegisteredToolEnabled(widget, settings)).toBe(true);
	});
});
