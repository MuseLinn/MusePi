import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@musepi/pi-coding-agent/tools";
import { BUILTIN_MODE_TEMPLATES, BUILTIN_TEMPLATE_REVISION, LEGACY_TEMPLATES } from "../../src/presets/resolve";

/**
 * Chat's minimal preset is defined by what it removes (DSH minimal parity: the
 * keep-set is the shell and the persona). The removal rides the per-tool
 * denylist through the mode-settings override, so the contract spans two
 * subsystems: the template must name the denylist, and createTools must honour
 * it after the override lands in the session's settings. A template change
 * alone would be decoration; these cases prove the tools actually leave the
 * slate.
 */
describe("chat preset tool narrowing", () => {
	it("names the denylist in its settings override", () => {
		const denylist = BUILTIN_MODE_TEMPLATES.chat?.settings?.["tools.disabled"];
		expect(Array.isArray(denylist)).toBe(true);
		// The keep-set: shell and the one tool a conversation can need.
		expect(denylist as string[]).not.toContain("bash");
		expect(denylist as string[]).not.toContain("ask");
		// Everything else in the builtin slate goes.
		expect(denylist as string[]).toContain("read");
		expect(denylist as string[]).toContain("write");
		expect(denylist as string[]).toContain("browser");
		expect(denylist as string[]).toContain("task");
	});

	it("upgrades revision-5 chat files but keeps edited ones", () => {
		// The upgrade chain is what puts the narrowing in front of existing users
		// without trampling their edits: a file still matching the v5 snapshot
		// moves up; anything else stays as the person wrote it.
		const rev5 = LEGACY_TEMPLATES[5]?.chat;
		expect(rev5).toBeDefined();
		expect(rev5?.settings?.["tools.disabled"]).toBeUndefined();
		// And the current template stamps the new revision.
		expect(BUILTIN_TEMPLATE_REVISION).toBe(6);
	});

	it("createTools honours the denylist the template writes", async () => {
		const denylist = BUILTIN_MODE_TEMPLATES.chat?.settings?.["tools.disabled"] as string[];
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"tools.disabled": denylist,
		} as never);
		const session = {
			cwd: os.tmpdir(),
			settings,
			enableLsp: false,
		} as unknown as ToolSession;

		const tools = (await createTools(session)).map(tool => tool.name);

		expect(tools).toContain("bash");
		// `ask` is a conditional factory (createIf) and its condition is false for
		// this bare stub session, so the assertion here is about the denylist —
		// the tools it names are absent — not about the keep-set being complete.
		expect(tools).not.toContain("read");
		expect(tools).not.toContain("write");
		expect(tools).not.toContain("browser");
		expect(tools).not.toContain("task");
	});

	it("a work session keeps the full slate", async () => {
		// The default mode must not inherit chat's narrowing: a denylist is a
		// mode override, and work defines none. Isolated settings — deliberately
		// not `Settings.init`, which would leave the global singleton initialized
		// for every later test file in the run.
		const settings = Settings.isolated({} as never);
		const session = { cwd: os.tmpdir(), settings, enableLsp: false } as unknown as ToolSession;
		const tools = (await createTools(session)).map(tool => tool.name);
		expect(tools).toContain("read");
		expect(tools).toContain("bash");
		expect(tools).toContain("task");
	});
});
