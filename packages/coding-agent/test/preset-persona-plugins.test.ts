/**
 * Contract: built-in preset personas are owned by bundled Cordis plugin
 * packages, not by `presets/resolve.ts`.
 *
 * Why this exists: the built-in chat/design/creator prompts used to live as
 * inline strings in the preset definitions. That made a preset both the
 * selection state and the text owner, so disabling a plugin, switching modes,
 * or reloading an extension could never actually remove a persona — the host
 * would just re-read the same static copy.
 *
 * The cases below pin the three halves of the ownership move:
 *   1. the preset definitions carry composition only;
 *   2. the package Markdown is the text source and the package mounts real
 *      Cordis fibers that register those sections;
 *   3. a session rebuild, mode switch, and template upgrade never leave an old
 *      persona behind or duplicate a live one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	BUILTIN_MODE_TEMPLATES,
	BUILTIN_TEMPLATE_REVISION,
	ensureModeTemplates,
	LEGACY_TEMPLATES,
	modeFilePath,
	resolveMode,
} from "@musepi/pi-coding-agent/presets/resolve";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { chatPersonaSections } from "../src/bundled-plugins/preset-chat/index";
import { creatorPersonaSections } from "../src/bundled-plugins/preset-creator/index";
import { designPersonaSections } from "../src/bundled-plugins/preset-design/index";
import { discoverBundledPluginPaths, discoverBundledPresetPluginPackages } from "../src/discovery/builtin";
import type { ExtensionAPI } from "../src/extensibility/extensions/types";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "../src/bundled-plugins");

const CHAT_PERSONA_HEAD = "你是一名简洁的对话助手。";
const DESIGN_ROLE_HEAD = "你是一名资深 UI/UX 设计师。";
const DESIGN_WORKFLOW_HEAD = "五步工作流:";
const CREATOR_PERSONA_HEAD = "你是一名 MusePi 插件与预设创作者。";

let home: string;
let modeDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-preset-persona-home-"));
	modeDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-preset-persona-modes-"));
	authStorage = await AuthStorage.create(path.join(home, "auth.db"));
	modelRegistry = new ModelRegistry(authStorage);
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	authStorage.close();
	vi.restoreAllMocks();
	for (const dir of [home, modeDir]) fs.rmSync(dir, { recursive: true, force: true });
});

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

function personaFile(...parts: string[]): string {
	return fs.readFileSync(path.join(PACKAGE_ROOT, ...parts), "utf8");
}

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

describe("preset composition owns selection, packages own persona text", () => {
	it("leaves the inline prompt arrays empty and declares the persona packages", () => {
		for (const [id, packageName] of [
			["chat", "musepi-preset-chat"],
			["design", "musepi-preset-design"],
			["creator", "musepi-preset-creator"],
		] as const) {
			const def = BUILTIN_MODE_TEMPLATES[id]!;
			expect(def.prompt ?? []).toEqual([]);
			expect(def.plugins?.some(row => row.name === packageName)).toBe(true);
		}
		// A resolve over the real definition must not resurrect the old text.
		expect(resolveMode("design", modeId => BUILTIN_MODE_TEMPLATES[modeId]).prompt).toEqual([]);
		expect(BUILTIN_TEMPLATE_REVISION).toBe(10);
	});

	it("keeps each persona's text in its own package Markdown", () => {
		expect(personaFile("preset-chat", "persona.md")).toContain(CHAT_PERSONA_HEAD);
		expect(personaFile("preset-design", "role.md")).toContain(DESIGN_ROLE_HEAD);
		expect(personaFile("preset-design", "workflow.md")).toContain(DESIGN_WORKFLOW_HEAD);
		expect(personaFile("preset-design", "brief.md")).toContain("简报协议");
		expect(personaFile("preset-design", "artifact.md")).toContain("artifact.manifest.json");
		expect(personaFile("preset-design", "boundary.md")).toContain("--radius-");
		expect(personaFile("preset-creator", "persona.md")).toContain(CREATOR_PERSONA_HEAD);
	});

	it("discovers persona packages for presets but keeps them out of ambient sessions", async () => {
		const presetPackages = await discoverBundledPresetPluginPackages();
		for (const name of ["musepi-preset-chat", "musepi-preset-design", "musepi-preset-creator"]) {
			expect(presetPackages.has(name)).toBe(true);
		}
		const ambient = await discoverBundledPluginPaths();
		// The discovery pass is shared; the manifest flag is what keeps a
		// preset-only package from loading in every session.
		for (const name of ["preset-chat", "preset-design", "preset-creator"]) {
			expect(ambient.some(entry => entry.includes(`bundled-plugins/${name}/`))).toBe(false);
		}
	});

	it("moves the revision-9 text byte for byte", () => {
		const texts = (entries: readonly unknown[] | undefined): string[] =>
			(entries ?? []).map(entry => (typeof entry === "string" ? entry : (entry as { text: string }).text));
		expect(chatPersonaSections.map(section => section.text)).toEqual(texts(LEGACY_TEMPLATES[9]?.chat?.prompt));
		expect(designPersonaSections.map(section => section.text)).toEqual(texts(LEGACY_TEMPLATES[9]?.design?.prompt));
		expect(creatorPersonaSections.map(section => section.text)).toEqual(texts(LEGACY_TEMPLATES[9]?.creator?.prompt));
	});

	it("registers the sections from the package's Cordis entry", async () => {
		const registered: Array<{ name: string; order: number; text: string }> = [];
		const api = {
			setLabel: () => {},
			registerPrompt: (section: { name: string; order: number; text: unknown }) => {
				if (typeof section.text === "string") registered.push({ ...section, text: section.text });
			},
			logger: { info: () => {} },
		} as unknown as ExtensionAPI;

		const design = await import("../src/bundled-plugins/preset-design/index");
		await design.default(api);
		expect(registered.map(section => [section.name, section.order])).toEqual([
			["mode:design:role", 25],
			["mode:design:workflow", 30],
			["mode:design:brief", 35],
			["mode:design:artifact", 40],
			["mode:design:boundary", 45],
		]);
		expect(registered[0]!.text).toContain(DESIGN_ROLE_HEAD);
		expect(registered[0]!.text).not.toContain("\n");

		registered.length = 0;
		const chat = await import("../src/bundled-plugins/preset-chat/index");
		await chat.default(api);
		expect(registered.map(section => section.name)).toEqual(["mode:chat:persona"]);
		expect(registered[0]!.text).toBe(`${CHAT_PERSONA_HEAD}只回答结论,不做多余分析;优先给出最小可行的方案。`);
	});
});

describe("template upgrade", () => {
	it("upgrades an untouched revision-9 preset to the package composition", () => {
		const legacy = LEGACY_TEMPLATES[9]?.design;
		expect(legacy).toBeDefined();
		// The historical snapshot must still be the literal inline-prompt shape,
		// not a spread over the current definition.
		expect(JSON.stringify(legacy)).toContain(DESIGN_ROLE_HEAD);
		fs.writeFileSync(
			modeFilePath(modeDir, "design"),
			`${JSON.stringify({ ...legacy, builtinRevision: 9 }, null, 2)}\n`,
			"utf8",
		);

		ensureModeTemplates(modeDir);

		const upgraded = JSON.parse(fs.readFileSync(modeFilePath(modeDir, "design"), "utf8")) as Record<string, unknown>;
		expect(upgraded.builtinRevision).toBe(BUILTIN_TEMPLATE_REVISION);
		expect(upgraded.prompt).toBeUndefined();
		expect(upgraded.plugins).toContainEqual({ name: "musepi-preset-design" });
	});

	it("preserves an edited revision-9 preset", () => {
		const legacy = LEGACY_TEMPLATES[9]?.chat;
		expect(legacy).toBeDefined();
		fs.writeFileSync(
			modeFilePath(modeDir, "chat"),
			`${JSON.stringify({ ...legacy, builtinRevision: 9, label: "My chat" }, null, 2)}\n`,
			"utf8",
		);

		ensureModeTemplates(modeDir);

		const after = JSON.parse(fs.readFileSync(modeFilePath(modeDir, "chat"), "utf8")) as Record<string, unknown>;
		expect(after.label).toBe("My chat");
		expect(after.builtinRevision).toBe(9);
	});
});

describe("session lifecycle", () => {
	it("mounts the persona from the package and drops it on every switch", async () => {
		const session = await createWithMode("design");
		let prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(DESIGN_ROLE_HEAD);
		expect(prompt).toContain(DESIGN_WORKFLOW_HEAD);
		expect(prompt).not.toContain(CHAT_PERSONA_HEAD);
		expect(occurrences(prompt, DESIGN_ROLE_HEAD)).toBe(1);

		expect(await session.setMode("chat")).toEqual({ ok: true });
		prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(CHAT_PERSONA_HEAD);
		expect(prompt).not.toContain(DESIGN_ROLE_HEAD);
		expect(prompt).not.toContain(DESIGN_WORKFLOW_HEAD);
		expect(occurrences(prompt, CHAT_PERSONA_HEAD)).toBe(1);

		expect(await session.setMode("design")).toEqual({ ok: true });
		prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(DESIGN_ROLE_HEAD);
		expect(prompt).not.toContain(CHAT_PERSONA_HEAD);
		expect(occurrences(prompt, DESIGN_ROLE_HEAD)).toBe(1);

		expect(await session.setMode(null)).toEqual({ ok: true });
		prompt = session.systemPrompt.join("\n");
		expect(prompt).not.toContain(DESIGN_ROLE_HEAD);
		expect(prompt).not.toContain(CHAT_PERSONA_HEAD);
	});

	it("registers no persona when the composition row is disabled", async () => {
		const disabled = {
			...BUILTIN_MODE_TEMPLATES.design,
			id: "designoff",
			label: "Design (persona off)",
			plugins: [{ name: "musepi-preset-design", enabled: false }, { name: "musepi-product-skills" }],
		};
		fs.writeFileSync(modeFilePath(modeDir, "designoff"), `${JSON.stringify(disabled, null, 2)}\n`, "utf8");

		const session = await createWithMode("designoff");
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).not.toContain(DESIGN_ROLE_HEAD);
		expect(prompt).not.toContain(DESIGN_WORKFLOW_HEAD);
	});

	it("gives creator its persona package and no design persona", async () => {
		const session = await createWithMode("creator");
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain(CREATOR_PERSONA_HEAD);
		expect(prompt).not.toContain(DESIGN_ROLE_HEAD);
		expect(occurrences(prompt, CREATOR_PERSONA_HEAD)).toBe(1);
	});
});
