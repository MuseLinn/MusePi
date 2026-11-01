import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { logger, removeSyncWithRetries } from "@musepi/pi-utils";

declare global {
	var __profilePresetDisposed: boolean | undefined;
}

let home: string;
let modeDir: string;
let registryDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-profile-resolution-home-"));
	modeDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-profile-resolution-modes-"));
	registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-profile-resolution-registry-"));
	vi.spyOn(os, "homedir").mockReturnValue(home);
	authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
	modelRegistry = new ModelRegistry(authStorage);
	const bundleDir = path.join(home, ".musepi", "plugins", "node_modules", "@musepi", "preset-bundle");
	fs.mkdirSync(bundleDir, { recursive: true });
	const activeDir = path.join(home, ".musepi", "plugins", "node_modules", "@demo", "active");
	fs.mkdirSync(activeDir, { recursive: true });
	await Bun.write(
		path.join(activeDir, "package.json"),
		JSON.stringify({ name: "@demo/active", version: "1.0.0", musepi: { extensions: ["./index.js"] } }),
	);
	await Bun.write(
		path.join(activeDir, "index.js"),
		`export function apply(pi) { pi.registerTool({ name: "profile_preset_tool", description: "profile preset", parameters: {}, execute: async () => ({ content: [] }) }); pi.effect(() => { globalThis.__profilePresetDisposed = true; }); }`,
	);
	await Bun.write(
		path.join(home, ".musepi", "plugins", "musepi-plugins.lock.json"),
		JSON.stringify({ plugins: { "@demo/active": { version: "1.0.0", enabled: true, enabledFeatures: null } } }),
	);
	await Bun.write(
		path.join(home, ".musepi", "package.json"),
		JSON.stringify({ musepi: { profile: { bundles: ["@musepi/preset-bundle"] } } }),
	);
	await Bun.write(
		path.join(bundleDir, "package.json"),
		JSON.stringify({ name: "@musepi/preset-bundle", dsh: { bundle: { patch: "./cordis.patch.yml" } } }),
	);
	await Bun.write(
		path.join(bundleDir, "cordis.patch.yml"),
		`- insert:\n    - id: preset-review\n      name: '@musepi/agent-preset'\n      config:\n        id: review\n        plugins:\n          - id: persona\n            name: '@musepi/persona'\n            config:\n              prefix: Profile reviewer\n          - id: active-tool\n            name: '@demo/active'\n`,
	);
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	authStorage.close();
	vi.restoreAllMocks();
	for (const dir of [home, modeDir, registryDir]) {
		if (fs.existsSync(dir)) removeSyncWithRetries(dir);
	}
});

async function createWithMode(id: string): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: registryDir,
		agentDir: registryDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: (await import("@musepi/pi-coding-agent/config/settings")).Settings.isolated({}),
		model: getBundledModel("openai", "gpt-4o-mini"),
		modeId: id,
		modeDir,
		profileHome: home,
		disableExtensionDiscovery: true,
	});
	sessions.push(session);
	return session;
}

describe("profile Agent preset resolution", () => {
	it("resolves a bundle-declared preset through the real SDK path", async () => {
		const errors = vi.spyOn(logger, "error");
		const session = await createWithMode("review");

		expect(errors.mock.calls).toEqual([]);
		expect(session.agent.state.systemPrompt.join("\n")).toContain("Profile reviewer");
		expect(session.getAllToolNames()).toContain("profile_preset_tool");
	});

	it("removes preset tools and disposes their fibers on a mode switch", async () => {
		const session = await createWithMode("review");
		expect(session.getAllToolNames()).toContain("profile_preset_tool");

		const result = await session.setMode("chat");

		expect(result).toEqual({ ok: true });
		expect(session.getAllToolNames()).not.toContain("profile_preset_tool");
		expect(globalThis.__profilePresetDisposed).toBe(true);
		delete globalThis.__profilePresetDisposed;
	});

	it("keeps a file preset authoritative when its id collides with the profile", async () => {
		await Bun.write(
			path.join(modeDir, "review.json"),
			JSON.stringify({ id: "review", prompt: [{ name: "file", order: 0, text: "File reviewer" }] }),
		);

		const session = await createWithMode("review");

		expect(session.agent.state.systemPrompt.join("\n")).toContain("File reviewer");
		expect(session.agent.state.systemPrompt.join("\n")).not.toContain("Profile reviewer");
	});
});
