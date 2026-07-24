// MusePi settings persistence — SettingsManager.setMusepiValue.
// The settings selector's MusePi submenu writes individual musepi.* keys
// by dot path; these tests cover nested-path writes, sibling preservation,
// and on-disk persistence through the queued writer.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager musepi settings", () => {
	const testDir = join(process.cwd(), "test-settings-musepi-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("writes a boolean by dot path and resolves it with defaults", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getMusepi().memory.enabled).toBe(false);

		manager.setMusepiValue("memory.enabled", true);
		await manager.flush();

		expect(manager.getMusepi().memory.enabled).toBe(true);

		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(saved.musepi.memory.enabled).toBe(true);
	});

	it("creates intermediate objects for deep paths and preserves siblings", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);

		manager.setMusepiValue("memory.caps.project", 20000);
		manager.setMusepiValue("memory.scope", "global");
		manager.setMusepiValue("mcp.idleTimeoutMs", 300000);
		await manager.flush();

		const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(saved.musepi.memory.caps.project).toBe(20000);
		expect(saved.musepi.memory.scope).toBe("global");
		expect(saved.musepi.mcp.idleTimeoutMs).toBe(300000);

		const resolved = manager.getMusepi();
		expect(resolved.memory.caps.project).toBe(20000);
		expect(resolved.memory.caps.global).toBe(6000); // untouched default
		expect(resolved.mcp.enabled).toBe(true); // untouched default
	});

	it("writes free-text values (model specs) and preserves other settings", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ theme: "dark", musepi: { updateCheck: false } }));

		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setMusepiValue("modelRoles.advisor", "openai/gpt-5:high");
		await manager.flush();

		const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(saved.theme).toBe("dark");
		expect(saved.musepi.updateCheck).toBe(false); // pre-existing musepi key preserved
		expect(saved.musepi.modelRoles.advisor).toBe("openai/gpt-5:high");
	});

	it("exposes the global settings path for edit-in-file hints", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getGlobalSettingsPath()).toBe(join(agentDir, "settings.json"));
	});
});
