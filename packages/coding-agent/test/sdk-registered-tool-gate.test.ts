/**
 * Session-level guard for registered-tool gating.
 *
 * `isRegisteredToolEnabled` is also unit-tested, but the bug this prevents was
 * in assembly: extension tools were always included, so `tools.disabled` and a
 * tool's own `enabled` predicate never reached the model. This test builds a
 * real session and reads the slate the model receives.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import { AuthStorage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@musepi/pi-utils";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import type { Extension, LoadExtensionsResult } from "../src/extensibility/extensions/types";
import { createAgentSession } from "../src/sdk";
import { EventBus } from "../src/utils/event-bus";

let dir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: Array<{ dispose(): Promise<void> }> = [];

async function probeExtension(): Promise<Extension> {
	const runtime = new ExtensionRuntime();
	return loadExtensionFromFactory(
		pi => {
			const probe = (name: string, enabled?: () => boolean) => ({
				name,
				label: name,
				description: name,
				parameters: type({}),
				loadMode: "essential" as const,
				...(enabled ? { enabled } : {}),
				execute: async () => ({ content: [{ type: "text" as const, text: name }] }),
			});
			pi.registerTool(probe("gated_probe", () => false));
			pi.registerTool(probe("always_probe"));
		},
		dir,
		new EventBus(),
		runtime,
		"gate-probe.ts",
	);
}

function preloaded(extension: Extension): LoadExtensionsResult {
	return {
		extensions: [extension],
		errors: [],
		runtime: new ExtensionRuntime(),
	};
}

async function activeToolNames(settings: Settings): Promise<string[]> {
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings,
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		preloadedExtensions: preloaded(await probeExtension()),
	});
	sessions.push(session);
	return session.getActiveToolNames();
}

describe("registered tool gate in session assembly", () => {
	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(dir)) removeSyncWithRetries(dir);
	});

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-registered-gate-"));
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	it("drops a registered tool whose enabled predicate says no", async () => {
		const names = await activeToolNames(Settings.isolated());
		expect(names).not.toContain("gated_probe");
		expect(names).toContain("always_probe");
	});

	it("keeps another registered tool from the same extension", async () => {
		const names = await activeToolNames(Settings.isolated());
		expect(names.filter(name => name.endsWith("_probe")).sort()).toEqual(["always_probe"]);
	});

	it("honours tools.disabled for registered tools too", async () => {
		const names = await activeToolNames(Settings.isolated({ "tools.disabled": ["always_probe"] }));
		expect(names).not.toContain("always_probe");
		expect(names).not.toContain("gated_probe");
	});
});
