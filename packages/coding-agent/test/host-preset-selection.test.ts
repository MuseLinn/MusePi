/**
 * A preset declared by an extension resolves through the host registry even
 * when THIS session's discovery did not load that extension (dsh's global
 * roster). Otherwise `agentPresets.list` could show a row another workspace
 * cannot select.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	recordHostExtensionModes,
	removeHostExtensionModes,
} from "@musepi/pi-coding-agent/extensibility/extensions/host-modes";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

const EXTENSION_ID = "/__host-preset-probe__";

let home: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-host-preset-"));
	authStorage = await AuthStorage.create(path.join(home, "auth.db"));
	modelRegistry = new ModelRegistry(authStorage);
	recordHostExtensionModes([
		{
			resolvedPath: EXTENSION_ID,
			modes: [
				{
					id: "host-probe-mode",
					label: "Host probe",
					prompt: [{ name: "host-probe", order: 40, text: "HOST_REGISTRY_PERSONA" }],
				},
			],
		} as never,
	]);
});

afterEach(() => {
	removeHostExtensionModes(EXTENSION_ID);
	authStorage.close();
	try {
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	} catch {
		// Windows may still hold the auth db; the OS cleans the temp dir.
	}
});

describe("host registry presets", () => {
	it("resolves a preset this session's discovery did not load", async () => {
		const { session } = await createAgentSession({
			cwd: home,
			agentDir: home,
			profileHome: home,
			modeDir: path.join(home, "modes"),
			modeId: "host-probe-mode",
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
		try {
			expect(session.systemPrompt.join("\n")).toContain("HOST_REGISTRY_PERSONA");
		} finally {
			await session.dispose();
		}
	});
});
