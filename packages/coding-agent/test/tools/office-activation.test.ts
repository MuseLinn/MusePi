import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import {
	DEFAULT_OFFICE_ACTIVATION_SKILLS,
	isOfficeActivationSkill,
	setOfficeActivationSkills,
} from "@musepi/pi-coding-agent/tools/office-activation";
import { TempDir } from "@musepi/pi-utils";

const OFFICE = ["office_render", "office_convert", "office_recalculate"];

describe("office activation", () => {
	let dir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		dir = TempDir.createSync("@pi-office-activation-");
		authStorage = await AuthStorage.create(path.join(dir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		authStorage.close();
		setOfficeActivationSkills(DEFAULT_OFFICE_ACTIVATION_SKILLS);
		try {
			await dir.remove();
		} catch {}
	}, 30_000);

	async function session() {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const settings = Settings.isolated({
			"async.enabled": false,
			"compaction.enabled": false,
		});
		const result = await createAgentSession({
			cwd: dir.path(),
			agentDir: dir.path(),
			sessionManager: SessionManager.inMemory(dir.path()),
			authStorage,
			modelRegistry,
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: dir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return result.session;
	}

	it("keeps the Office tools out of the first slate", async () => {
		const agent = await session();
		try {
			const active = agent.getActiveToolNames();
			for (const name of OFFICE) expect(active).not.toContain(name);
			// Registered, so activation can admit them without rebuilding the session.
			for (const name of OFFICE) expect(agent.hasBuiltInTool(name)).toBe(true);
		} finally {
			await agent.dispose();
		}
	});

	it("admits the whole group when an Office skill is activated", async () => {
		const agent = await session();
		try {
			await agent.activateSkill("other");
			expect(agent.isSkillActivated("other")).toBe(true);
			for (const name of OFFICE) expect(agent.getActiveToolNames()).not.toContain(name);

			await agent.activateSkill("office");
			expect(agent.isSkillActivated("office")).toBe(true);
			const active = agent.getActiveToolNames();
			for (const name of OFFICE) expect(active).toContain(name);
		} finally {
			await agent.dispose();
		}
	});

	it("honours a configured activation skill set", () => {
		expect(isOfficeActivationSkill("office")).toBe(true);
		expect(isOfficeActivationSkill("office-docx")).toBe(true);
		expect(isOfficeActivationSkill("custom-office")).toBe(false);
		setOfficeActivationSkills(["custom-office"]);
		expect(isOfficeActivationSkill("custom-office")).toBe(true);
		expect(isOfficeActivationSkill("office")).toBe(false);
		setOfficeActivationSkills([]);
		expect(isOfficeActivationSkill("office")).toBe(true);
	});
});
