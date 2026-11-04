/**
 * Preset lifecycle contract: switching a preset before the first message must
 * rebuild the tool slate, a switched-away preset must not come back through an
 * extension reload, and a preset whose persona package cannot mount must fail
 * closed instead of falling back to the full default prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { BUILTIN_MODE_TEMPLATES, modeFilePath } from "@musepi/pi-coding-agent/presets/resolve";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../src/bundled-plugins");
const CHAT_PERSONA_HEAD = "你是一名简洁的对话助手。";
const DESIGN_ROLE_HEAD = "你是一名资深 UI/UX 设计师。";

let home: string;
let modeDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-preset-lifecycle-home-"));
	modeDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-preset-lifecycle-modes-"));
	authStorage = await AuthStorage.create(path.join(home, "auth.db"));
	modelRegistry = new ModelRegistry(authStorage);
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	authStorage.close();
	vi.restoreAllMocks();
	for (const dir of [home, modeDir]) fs.rmSync(dir, { recursive: true, force: true });
});

async function createWithMode(id: string): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: home,
		agentDir: home,
		profileHome: home,
		modeDir,
		modeId: id,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
	});
	sessions.push(session);
	return session;
}

describe("preset switch rebuilds the tool slate before the first message", () => {
	it("chat → work restores the full built-in slate and drops chat's persona", async () => {
		const session = await createWithMode("chat");
		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).toContain("bash");
		expect(session.systemPrompt.join("\n")).toContain(CHAT_PERSONA_HEAD);

		expect(await session.setMode("work")).toEqual({ ok: true });

		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["bash", "read", "edit", "grep"]));
		expect(session.systemPrompt.join("\n")).not.toContain(CHAT_PERSONA_HEAD);
	});

	it("work → chat narrows the slate back to the chat keep-set", async () => {
		const session = await createWithMode("work");
		expect(session.getActiveToolNames()).toContain("read");

		expect(await session.setMode("chat")).toEqual({ ok: true });

		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).toContain("bash");
		expect(session.systemPrompt.join("\n")).toContain(CHAT_PERSONA_HEAD);
	});
});

describe("switched-away preset records stay gone", () => {
	it("does not list or resurrect the design persona after switching to chat", async () => {
		const session = await createWithMode("design");
		const personaPath = path.resolve(PACKAGE_ROOT, "preset-design", "index.ts");
		const hasPersona = (): boolean =>
			session.listLoadedExtensions().some(extension => path.resolve(extension.path) === personaPath);

		expect(hasPersona()).toBe(true);
		expect(await session.setMode("chat")).toEqual({ ok: true });
		expect(hasPersona()).toBe(false);
		expect(session.getExtensionEntryMtimes().has(personaPath)).toBe(false);

		// A hot reload (daemon HMR) must not find the disposed synthetic record.
		await session.reloadExtension(personaPath);
		expect(session.systemPrompt.join("\n")).not.toContain(DESIGN_ROLE_HEAD);
		expect(hasPersona()).toBe(false);
	});
});

describe("persona mount failure is fail-closed", () => {
	it("refuses to start a preset whose persona package cannot mount", async () => {
		const broken = {
			...BUILTIN_MODE_TEMPLATES.chat,
			id: "brokenchat",
			label: "Broken chat",
			plugins: [{ name: "musepi-preset-chat-not-installed" }],
		};
		fs.writeFileSync(modeFilePath(modeDir, "brokenchat"), `${JSON.stringify(broken, null, 2)}\n`, "utf8");

		await expect(createWithMode("brokenchat")).rejects.toThrow(/brokenchat/);
	});
});
