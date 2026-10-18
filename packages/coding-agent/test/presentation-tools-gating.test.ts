import { describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@musepi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@musepi/pi-coding-agent/tools";

/**
 * Presentation-tool gating (`widget`, `board`).
 *
 * Contract: both are registered only while their setting is on. Before this
 * gate existed they were registered unconditionally — `BUILTIN_TOOLS.widget`
 * and `BUILTIN_TOOLS.board` are plain factories with no `createIf`, so the
 * model always saw them and a user who did not want an agent drawing cards in
 * the transcript or writing to the desktop board had no way to say so.
 *
 * The observable contract is the tool list the model receives: an off tool is
 * absent from it (so it cannot be called and costs no context), and an on tool
 * is present.
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

describe("presentation tool gating", () => {
	it("offers widget and board by default", async () => {
		const names = await toolNames();
		expect(names).toContain("widget");
		expect(names).toContain("board");
	});

	it("drops widget when its setting is off, leaving board alone", async () => {
		const names = await toolNames({ "widget.enabled": false });
		expect(names).not.toContain("widget");
		// The gate must be per-tool, not a shared switch.
		expect(names).toContain("board");
	});

	it("drops board when its setting is off, leaving widget alone", async () => {
		const names = await toolNames({ "board.enabled": false });
		expect(names).not.toContain("board");
		expect(names).toContain("widget");
	});

	it("drops both when both are off", async () => {
		const names = await toolNames({ "widget.enabled": false, "board.enabled": false });
		expect(names).not.toContain("widget");
		expect(names).not.toContain("board");
	});

	it("keeps the rest of the tool set intact when presentation tools are off", async () => {
		// A gate that accidentally collapsed the whole list would still pass the
		// assertions above; this pins that unrelated tools survive.
		const names = await toolNames({ "widget.enabled": false, "board.enabled": false });
		expect(names).toContain("read");
		expect(names).toContain("bash");
		expect(names.length).toBeGreaterThan(5);
	});
});
