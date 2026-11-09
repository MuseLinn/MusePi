import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentStorage } from "@musepi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@musepi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("Settings.reloadFromDisk", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-settings-reload-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	it("re-reads global and project config without replacing the instance", async () => {
		const projectConfig = path.join(getProjectAgentDir(projectDir), "config.yml");
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify({ autocompleteMaxVisible: 15 }));
		await Bun.write(projectConfig, YAML.stringify({ autocompleteMaxVisible: 20 }));

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("autocompleteMaxVisible")).toBe(20);

		await Bun.write(projectConfig, YAML.stringify({ autocompleteMaxVisible: 25 }));
		await settings.reloadFromDisk();
		// Same instance, new file state.
		expect(Settings.instance).toBe(settings);
		expect(settings.get("autocompleteMaxVisible")).toBe(25);

		await fs.promises.rm(projectConfig);
		await settings.reloadFromDisk();
		expect(settings.get("autocompleteMaxVisible")).toBe(15);
	});
});
