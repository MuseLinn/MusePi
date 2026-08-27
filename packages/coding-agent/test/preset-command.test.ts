import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../src/session/agent-session";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "../src/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "../src/slash-commands/types";

/** TUI preset (mode) parity with the GUI ModesCenter: /preset lists and
 *  hot-switches presets in-session (modes v2 switcher). */
describe("/preset command (TUI preset parity)", () => {
	function presetCommand(): (typeof BUILTIN_SLASH_COMMANDS_INTERNAL)[number] {
		const cmd = BUILTIN_SLASH_COMMANDS_INTERNAL.find(c => c.name === "preset");
		if (!cmd) throw new Error("preset command not registered");
		return cmd;
	}

	function makeRuntime(overrides: { modeId?: string | null; modesDir?: string } = {}): {
		runtime: SlashCommandRuntime;
		outputs: string[];
		setModeCalls: Array<{ modeId: string; hot?: boolean }>;
	} {
		const outputs: string[] = [];
		const setModeCalls: Array<{ modeId: string; hot?: boolean }> = [];
		const session = {
			setMode: async (modeId: string, opts: { hot?: boolean }) => {
				setModeCalls.push({ modeId, hot: opts.hot });
				return { ok: true };
			},
		} as unknown as AgentSession;
		return {
			runtime: {
				session,
				sessionManager: { getHeader: () => ({ modeId: overrides.modeId ?? null }) },
				settings: {},
				cwd: "",
				output: (text: string) => {
					outputs.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: () => Promise.resolve(),
			} as unknown as SlashCommandRuntime,
			outputs,
			setModeCalls,
		};
	}

	it("bare /preset shows the current session preset", async () => {
		const { runtime, outputs } = makeRuntime({ modeId: "minimal" });
		await presetCommand().handle?.({ args: "" } as never, runtime);
		// i18n key (test env returns the key itself) or its translation — the
		// contract is that a status line is emitted for the current mode.
		expect(outputs.join("\n")).toMatch(/preset slash current|当前预设/);
	});

	it("/preset use <id> hot-switches via session.setMode", async () => {
		const { runtime, setModeCalls } = makeRuntime();
		await presetCommand().handle?.({ args: "use design" } as never, runtime);
		expect(setModeCalls).toEqual([{ modeId: "design", hot: true }]);
	});

	it("/preset use rejects an invalid mode id (no setMode call)", async () => {
		const { runtime, setModeCalls } = makeRuntime();
		await presetCommand().handle?.({ args: "use BAD!" } as never, runtime);
		expect(setModeCalls).toEqual([]);
	});

	it("/preset list enumerates the modes dir and marks the current one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-modes-"));
		writeFileSync(join(dir, "work.json"), "{}");
		writeFileSync(join(dir, "design.json"), "{}");
		try {
			const prev = process.env.MUSEPI_MODES_DIR;
			process.env.MUSEPI_MODES_DIR = dir;
			const { runtime, outputs } = makeRuntime({ modeId: "work" });
			await presetCommand().handle?.({ args: "list" } as never, runtime);
			expect(outputs.join("\n")).toContain("* work");
			expect(outputs.join("\n")).toContain("design");
			if (prev === undefined) delete process.env.MUSEPI_MODES_DIR;
			else process.env.MUSEPI_MODES_DIR = prev;
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
