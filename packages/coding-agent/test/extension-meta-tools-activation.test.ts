import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { EXTENSION_META_TOOL_NAMES } from "@musepi/pi-coding-agent/extensibility/extension-meta-tools";
import type { CreateAgentSessionOptions, CustomTool } from "@musepi/pi-coding-agent/sdk";
import { createAgentSession, discoverAuthStorage } from "@musepi/pi-coding-agent/sdk";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@musepi/pi-utils";

/**
 * Contract: `tools.extensionMetaTools` (settings/preset override — the creator
 * preset sets it) must surface the extension bootstrap ring
 * (extension_load/reload/status/validate/rollback + ext_define/run/stop/
 * undefine/inspect) as top-level active tools from session start, instead of
 * the default state where defaultInactive custom tools only mount as xd://
 * devices and need /extensions for top-level access.
 */
describe("tools.extensionMetaTools initial activation", () => {
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;
	const tempDirs: string[] = [];

	const makeTempDir = (): string => {
		const tempDir = path.join(os.tmpdir(), `pi-ext-meta-activation-${Snowflake.next()}`);
		tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	};

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-ext-meta-activation-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterAll(() => {
		modelRegistry.authStorage.close();
		removeSyncWithRetries(registryAuthDir);
		for (const tempDir of tempDirs.splice(0)) removeSyncWithRetries(tempDir);
	});

	const baseOptions = (tempDir: string): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	// Stand-ins carrying the real meta-tool names: the daemon registers the
	// genuine factories as customTools; here we only need same-named custom
	// tools to prove the activation wiring.
	const metaRingTools: CustomTool[] = EXTENSION_META_TOOL_NAMES.map(name => ({
		name,
		label: `Probe ${name}`,
		description: `Probe stand-in for ${name}.`,
		parameters: type({}),
		defaultInactive: true,
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	}));

	it("keeps defaultInactive custom tools off the top-level active set by default", async () => {
		const tempDir = makeTempDir();
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			customTools: [metaRingTools[0]],
		});
		try {
			const name = metaRingTools[0].name;
			expect(session.getAllToolNames()).toContain(name);
			expect(session.getActiveToolNames()).not.toContain(name);
			// Default state: discoverable as an xd:// device only.
			expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(name);
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(`xd://${name}`);
			// Top-level rendering is label-first with the name in backticks — the
			// default-inactive tool must not get that treatment.
			expect(prompt).not.toContain(`\`${name}\``);
		} finally {
			await session.dispose();
		}
	});

	it("activates the extension meta ring top-level when tools.extensionMetaTools is on", async () => {
		const tempDir = makeTempDir();
		const settings = Settings.isolated({ "tools.extensionMetaTools": true });
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			customTools: metaRingTools,
		});
		try {
			for (const name of EXTENSION_META_TOOL_NAMES) {
				expect(session.getActiveToolNames()).toContain(name);
				expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(name);
			}
			const prompt = session.systemPrompt.join("\n");
			for (const name of EXTENSION_META_TOOL_NAMES) {
				// Top-level tools render label-first with the name in backticks.
				expect(prompt).toContain(`\`${name}\``);
			}
			expect(prompt).not.toContain("xd://extension_load");
		} finally {
			await session.dispose();
		}
	});

	it("leaves the meta ring off when the setting is explicitly false", async () => {
		const tempDir = makeTempDir();
		const settings = Settings.isolated({ "tools.extensionMetaTools": false });
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			customTools: [metaRingTools[0]],
		});
		try {
			expect(session.getActiveToolNames()).not.toContain(metaRingTools[0].name);
		} finally {
			await session.dispose();
		}
	});

	it("does not widen an explicit toolNames list with the meta ring", async () => {
		const tempDir = makeTempDir();
		const settings = Settings.isolated({ "tools.extensionMetaTools": true });
		const { session } = await createAgentSession({
			...baseOptions(tempDir),
			settings,
			customTools: [metaRingTools[0]],
			toolNames: ["read"],
		});
		try {
			expect(session.getActiveToolNames()).toContain("read");
			expect(session.getActiveToolNames()).not.toContain(metaRingTools[0].name);
		} finally {
			await session.dispose();
		}
	});
});
