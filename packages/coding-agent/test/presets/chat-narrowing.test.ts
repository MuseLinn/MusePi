import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { BUILTIN_TOOLS, createTools, type ToolSession } from "@musepi/pi-coding-agent/tools";
import {
	BUILTIN_MODE_TEMPLATES,
	BUILTIN_TEMPLATE_REVISION,
	ensureModeTemplates,
	LEGACY_TEMPLATES,
	modeFilePath,
} from "../../src/presets/resolve";

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

	it("makes an explicit choice for every current built-in tool", () => {
		const denylist = BUILTIN_MODE_TEMPLATES.chat?.settings?.["tools.disabled"] as string[];
		// A builtin that is neither in the keep-set nor in the denylist fails here:
		// the chat slate grows silently otherwise, which is how the secret tools
		// slipped in before revision 12.
		const keep = new Set(["bash", "ask"]);
		for (const name of Object.keys(BUILTIN_TOOLS)) {
			if (!keep.has(name)) expect(denylist).toContain(name);
		}
		expect(denylist).toContain("request_secret");
		expect(denylist).toContain("list_secrets");
	});

	it("tracks the legacy chat snapshots and current revision", () => {
		// The upgrade chain is what puts the narrowing in front of existing users
		// without trampling their edits: a file still matching a snapshot moves up;
		// anything else stays as the person wrote it.
		const rev5 = LEGACY_TEMPLATES[5]?.chat;
		expect(rev5).toBeDefined();
		expect(rev5?.settings?.["tools.disabled"]).toBeUndefined();
		const rev6 = LEGACY_TEMPLATES[6]?.chat;
		expect(rev6).toBeDefined();
		expect(rev6?.settings?.["tools.disabled"]).not.toContain("knowledge");
		const rev11 = LEGACY_TEMPLATES[11]?.chat;
		expect(rev11).toBeDefined();
		expect(rev11?.settings?.["tools.disabled"]).toContain("connector_catalog");
		expect(rev11?.settings?.["tools.disabled"]).not.toContain("request_secret");
		expect(rev11?.settings?.["tools.disabled"]).not.toContain("list_secrets");
		// And the current template stamps the new revision.
		const rev12 = LEGACY_TEMPLATES[12]?.chat;
		expect(rev12).toBeDefined();
		expect(rev12?.settings?.["tools.disabled"]).toContain("request_secret");
		expect(rev12?.settings?.["tools.disabled"]).not.toContain("present");
		expect(rev12?.settings?.["tools.disabled"]).not.toContain("request_login");
		expect(BUILTIN_TEMPLATE_REVISION).toBe(13);
	});

	it("upgrades an unedited revision-12 chat file and denies recently added tools", () => {
		const rev12 = LEGACY_TEMPLATES[12]?.chat;
		if (!rev12) throw new Error("revision 12 chat snapshot is missing");
		const dir = mkdtempSync(path.join(os.tmpdir(), "musepi-chat-preset-"));
		try {
			const file = modeFilePath(dir, "chat");
			writeFileSync(file, `${JSON.stringify({ ...rev12, builtinRevision: 12 }, null, 2)}\n`, "utf8");

			ensureModeTemplates(dir);

			const upgraded = JSON.parse(readFileSync(file, "utf8")) as {
				builtinRevision: number;
				settings: Record<string, unknown>;
			};
			expect(upgraded.builtinRevision).toBe(BUILTIN_TEMPLATE_REVISION);
			expect(upgraded.settings["tools.disabled"]).toContain("present");
			expect(upgraded.settings["tools.disabled"]).toContain("request_login");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
