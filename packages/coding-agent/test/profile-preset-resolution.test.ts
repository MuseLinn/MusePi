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
import { removeSyncWithRetries } from "@musepi/pi-utils";

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
		const session = await createWithMode("review");

		expect(session.agent.state.systemPrompt.join("\n")).toContain("Profile reviewer");
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
