/**
 * PromptHost session integration (core prompt pluginization, Task 2).
 *
 * Contract: every real session (main agent and the subagent-shaped
 * `systemPrompt`-function path) owns one PromptHost; extension factories reach
 * it through `pi.promptHost`; the assembly passes active tools and wire names;
 * host sections merge into the base prompt anchored by `baseSlots`; extension
 * enable/disable and HMR remove and restore host contributions without
 * residue.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { extensionHostOwner } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import { modeFilePath } from "@musepi/pi-coding-agent/presets/resolve";
import { removeScopedPromptHostLedger, replayPromptHostLedger } from "@musepi/pi-coding-agent/prompts/host";
import { createAgentSession, loadSessionExtensions } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";

let home: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
const sessions: AgentSession[] = [];

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-prompt-host-home-"));
	authStorage = await AuthStorage.create(path.join(home, "auth.db"));
	modelRegistry = new ModelRegistry(authStorage);
});

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	authStorage.close();
	for (const dir of [home]) fs.rmSync(dir, { recursive: true, force: true });
});

function baseSessionOptions(): Parameters<typeof createAgentSession>[0] {
	return {
		cwd: home,
		agentDir: home,
		profileHome: home,
		modelRegistry,
		authStorage,
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
	};
}

async function createHostSession(
	options: Partial<Parameters<typeof createAgentSession>[0]> = {},
): Promise<AgentSession> {
	const { session } = await createAgentSession({ ...baseSessionOptions(), ...options });
	sessions.push(session);
	return session;
}

describe("prompt host session assembly (main agent)", () => {
	it("reaches pi.promptHost in an inline factory and renders gated tool sections with wire names", async () => {
		let sawHost = false;
		const session = await createHostSession({
			extensions: [
				pi => {
					if (!pi.promptHost) return;
					sawHost = true;
					pi.promptHost.registerTool({
						tool: "read",
						text: context => `HOST-READ[wire=${context.wireName}]`,
					});
					pi.promptHost.registerTool({
						tool: "lsp",
						text: () => "HOST-LSP-SHOULD-NOT-RENDER",
					});
				},
			],
		});
		expect(sawHost).toBe(true);

		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("HOST-READ[wire=read]");
		expect(prompt).not.toContain("HOST-LSP-SHOULD-NOT-RENDER");
	});

	it("updates tool-gated sections when the active tool set changes", async () => {
		const session = await createHostSession({
			extensions: [
				pi => {
					pi.promptHost?.registerTool({ tool: "grep", text: () => "HOST-GREP-SECTION" });
				},
			],
		});
		expect(session.systemPrompt.join("\n")).toContain("HOST-GREP-SECTION");

		await session.setActiveToolsByName(session.getActiveToolNames().filter(name => name !== "grep"));
		expect(session.systemPrompt.join("\n")).not.toContain("HOST-GREP-SECTION");
	});

	it("merges host sections into the base prompt anchored by baseSlots", async () => {
		const session = await createHostSession({
			extensions: [
				pi => {
					pi.promptHost?.registerSection({ name: "host:injection", order: 25, text: "HOST-INJECTION" });
					pi.promptHost?.registerSection({ name: "host:tail", order: 350, text: "HOST-TAIL" });
				},
			],
		});
		const blocks = session.systemPrompt;
		expect(blocks).toContain("HOST-INJECTION");
		expect(blocks).toContain("HOST-TAIL");
		// Injection group (<100) lands right behind the core block; repo group (>=300) closes the prompt.
		expect(blocks.indexOf("HOST-INJECTION")).toBe(1);
		expect(blocks.indexOf("HOST-TAIL")).toBe(blocks.length - 1);
	});

	it("passes the active tool references to ordinary sections via toolRefs", async () => {
		const session = await createHostSession({
			extensions: [
				pi => {
					pi.promptHost?.registerSection({
						name: "host:refs",
						order: 25,
						text: context =>
							`HOST-REFS[${String((context as { toolRefs?: Record<string, string> }).toolRefs?.read)}]`,
					});
				},
			],
		});
		expect(session.systemPrompt.join("\n")).toContain("HOST-REFS[read]");
	});

	it("passes the real Auto-QA setting to the core host-integration plugin", async () => {
		const session = await createHostSession({
			settings: Settings.isolated({ "compaction.enabled": false, "dev.autoqa": true }),
		});
		expect(session.systemPrompt.join("\n")).toContain("`write` xd://report_issue: automated QA.");
	});
});

describe("prompt host reaches the subagent-shaped prompt branch", () => {
	it("merges host sections before a systemPrompt function transform", async () => {
		const session = await createHostSession({
			extensions: [
				pi => {
					pi.promptHost?.registerTool({ tool: "read", text: () => "HOST-SUB-READ" });
				},
			],
			// Subagents (task executor) pass a function; the host merge must land
			// in the default prompt they transform, not be skipped by the branch.
			systemPrompt: base => base,
		});
		expect(session.systemPrompt.join("\n")).toContain("HOST-SUB-READ");
	});
});

describe("complete prompt conflicts", () => {
	it("lets a single host complete section replace ordinary composer sections", async () => {
		const session = await createHostSession({
			extensions: [
				pi => {
					pi.promptHost?.registerSection({ name: "host-complete", order: 0, text: "HOST", complete: true });
					pi.registerPrompt({ name: "composer-ordinary", order: 0, text: "COMPOSER" });
				},
			],
		});
		expect(session.systemPrompt).toEqual(["HOST"]);
	});

	it("rejects a host complete section competing with a complete preset", async () => {
		using tempDir = TempDir.createSync("@pi-host-complete-preset-");
		const modesDir = tempDir.join("modes");
		fs.mkdirSync(modesDir, { recursive: true });
		fs.writeFileSync(
			modeFilePath(modesDir, "complete"),
			`${JSON.stringify({ id: "complete", label: "Complete", extensions: [], plugins: [], prompt: [], promptComplete: true })}\n`,
			"utf8",
		);
		await expect(
			createHostSession({
				modeDir: modesDir,
				modeId: "complete",
				extensions: [
					pi => {
						pi.promptHost?.registerSection({ name: "host-complete", order: 0, text: "HOST", complete: true });
					},
				],
			}),
		).rejects.toThrow(/complete/i);
	});
});

describe("core prompt packages mount per session", () => {
	const delegationPlugin = path.resolve(import.meta.dir, "../src/bundled-plugins/delegation/index.ts");
	const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

	it("supplies the default batch/scout delegation gates to the host assembly", async () => {
		// No `preloadedExtensionPaths`: discovery is disabled, so only the
		// session-level core mount can bring the delegation gates in.
		const session = await createHostSession();
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("one `tasks[]` array");
		expect(prompt).toContain("one read-only scout while working is allowed");
		expect(countOf(prompt, "## Delegation")).toBe(1);
	});

	it("renders restricted settings variants instead of constant delegation text", async () => {
		const session = await createHostSession({
			settings: Settings.isolated({
				"compaction.enabled": false,
				"task.batch": false,
				"task.disabledAgents": ["scout"],
			}),
		});
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("parallel calls in one message");
		expect(prompt).not.toContain("one `tasks[]` array");
		expect(prompt).not.toContain("read-only scout");
	});

	it("keeps one delegation block when the core path is also preloaded", async () => {
		// A caller that pre-resolved the core path (the old subagent forwarding
		// pattern) must not stack a second copy on top of the session mount.
		const session = await createHostSession({
			preloadedExtensionPaths: [delegationPlugin, delegationPlugin],
		});
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("one `tasks[]` array");
		expect(countOf(prompt, "## Delegation")).toBe(1);
	});

	it("remounts core packages through the shared runtime without re-executing other preloaded extensions", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-host-preload-");
		const otherExt = tempDir.join("preload-other-ext.ts");
		fs.writeFileSync(
			otherExt,
			`
export default function (api) {
	globalThis.__PRELOAD_OTHER_RUNS = ((globalThis.__PRELOAD_OTHER_RUNS ?? 0) | 0) + 1;
	api.registerPrompt({ name: "preload-other", order: 25, text: "PRELOAD-OTHER-SECTION" });
}
`,
			"utf8",
		);
		const { EventBus } = await import("@musepi/pi-coding-agent/utils/event-bus");
		const eventBus = new EventBus();
		const preloadSettings = Settings.isolated({ "compaction.enabled": false });
		// The CLI preload flow: load once outside the session, hand the result
		// back through `preloadedExtensions`.
		const preloaded = await loadSessionExtensions(
			{ disableExtensionDiscovery: true, additionalExtensionPaths: [otherExt] },
			home,
			preloadSettings,
			eventBus,
		);
		expect((globalThis as { __PRELOAD_OTHER_RUNS?: number }).__PRELOAD_OTHER_RUNS).toBe(1);
		expect(preloaded.extensions.map(extension => extension.resolvedPath)).toContain(otherExt);
		expect(preloaded.extensions.find(extension => extension.resolvedPath === otherExt)?.promptSections).toHaveLength(
			1,
		);

		const session = await createHostSession({ preloadedExtensions: preloaded, eventBus, settings: preloadSettings });
		try {
			expect(session.listLoadedExtensions().find(extension => extension.path === otherExt)?.promptSections).toEqual([
				"preload-other",
			]);
			const prompt = session.systemPrompt.join("\n");
			// Core packages remounted through the shared runtime reach the prompt
			// host even though the preload pass ran without one.
			expect(prompt).toContain("one `tasks[]` array");
			expect(countOf(prompt, "## Delegation")).toBe(1);
			// The other preloaded extension stays live and ran exactly once.
			expect(prompt).toContain("PRELOAD-OTHER-SECTION");
			expect(countOf(prompt, "PRELOAD-OTHER-SECTION")).toBe(1);
			expect((globalThis as { __PRELOAD_OTHER_RUNS?: number }).__PRELOAD_OTHER_RUNS).toBe(1);
		} finally {
			delete (globalThis as { __PRELOAD_OTHER_RUNS?: number }).__PRELOAD_OTHER_RUNS;
		}
	});
});

describe("runtime context single ownership in real sessions", () => {
	const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

	it("keeps the user append single-owned with a custom system prompt", async () => {
		const session = await createHostSession({
			settings: Settings.isolated({ "compaction.enabled": false, "autolearn.enabled": true }),
			customSystemPrompt: "CUSTOM BASE PROMPT",
			appendSystemPrompt: "USER-APPEND-UNIQUE-MARKER",
		});
		const prompt = session.systemPrompt.join("\n\n");
		expect(prompt).toContain("CUSTOM BASE PROMPT");
		// The custom template renders the user append in its original position;
		// the host runtime-context omits its copy to avoid a double write.
		expect(countOf(prompt, "USER-APPEND-UNIQUE-MARKER")).toBe(1);
		// The runtime appendix (auto-learn guidance) still reaches the custom
		// layout through the host:runtime-context plugin section — exactly once.
		expect(countOf(prompt, "## Auto-Learn (experimental)")).toBe(1);
	});

	it("carries the user append through the host runtime-context in the default layout", async () => {
		const session = await createHostSession({
			settings: Settings.isolated({ "compaction.enabled": false, "autolearn.enabled": true }),
			appendSystemPrompt: "USER-APPEND-DEFAULT-MARKER",
		});
		const prompt = session.systemPrompt.join("\n\n");
		// Single owner: the plugin section renders both the append and the
		// auto-learn guidance once; the base project footer carries neither.
		expect(countOf(prompt, "USER-APPEND-DEFAULT-MARKER")).toBe(1);
		expect(countOf(prompt, "## Auto-Learn (experimental)")).toBe(1);
	});
});

describe("prompt host extension lifecycle", () => {
	it("closes the prompt host when the session disposes", async () => {
		const result = await createAgentSession(baseSessionOptions());
		sessions.push(result.session);
		expect(result.promptHost).toBeDefined();
		await result.session.dispose();
		expect(result.promptHost?.closed).toBe(true);
		// A closed host rejects late registrations from unwinding handlers...
		expect(() => result.promptHost?.registerSection({ name: "late-section", order: 25, text: "LATE" })).toThrow(
			/closed/,
		);
		// ...while assemblies against it come back empty instead of throwing.
		expect(result.promptHost?.assemble().sections).toEqual([]);
	});

	it("hot reload swaps host sections without residue", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-host-hmr-");
		const entry = tempDir.join("hmr-host-ext.ts");
		const source = (text: string): string => `
export const name = "hmr-host-ext";
export function apply(pi) {
	if (pi.promptHost) {
		pi.promptHost.removeByOwner("hmr-host-ext-owner");
		pi.promptHost.registerSection({
			name: "hmr-host-section",
			order: 25,
			text: ${JSON.stringify(text)},
			owner: "hmr-host-ext-owner",
		});
	}
}
`;
		fs.writeFileSync(entry, source("HMR-HOST-V1"), "utf8");
		const session = await createHostSession({ additionalExtensionPaths: [entry] });
		expect(session.systemPrompt.join("\n")).toContain("HMR-HOST-V1");

		fs.writeFileSync(entry, source("HMR-HOST-V2"), "utf8");
		const result = await session.reloadExtension(entry);
		expect(result.errors).toEqual([]);

		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("HMR-HOST-V2");
		expect(prompt).not.toContain("HMR-HOST-V1");
	});

	it("mode switch disable removes host sections and re-enable restores them", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-host-modes-");
		const modesDir = tempDir.join("modes");
		fs.mkdirSync(modesDir, { recursive: true });
		const entry = tempDir.join("host-toggle-ext.ts");
		fs.writeFileSync(
			entry,
			`
export const name = "host-toggle-ext";
export function apply(pi) {
	if (pi.promptHost) {
		pi.promptHost.removeByOwner("host-toggle-owner");
		pi.promptHost.registerSection({
			name: "host-toggle-section",
			order: 25,
			text: "HOST-TOGGLE-SECTION",
			owner: "host-toggle-owner",
		});
	}
}
`,
			"utf8",
		);
		const extId = "host-toggle-ext";
		fs.writeFileSync(
			modeFilePath(modesDir, "hoston"),
			`${JSON.stringify({ id: "hoston", label: "Host On", extensions: [extId], plugins: [], prompt: [] }, null, 2)}\n`,
			"utf8",
		);
		fs.writeFileSync(
			modeFilePath(modesDir, "hostoff"),
			`${JSON.stringify({ id: "hostoff", label: "Host Off", extensions: [], plugins: [], prompt: [] }, null, 2)}\n`,
			"utf8",
		);

		const session = await createHostSession({
			modeDir: modesDir,
			modeId: "hoston",
			additionalExtensionPaths: [entry],
		});
		expect(session.systemPrompt.join("\n")).toContain("HOST-TOGGLE-SECTION");

		expect(await session.setMode("hostoff")).toEqual({ ok: true });
		expect(session.systemPrompt.join("\n")).not.toContain("HOST-TOGGLE-SECTION");

		expect(await session.setMode("hoston")).toEqual({ ok: true });
		expect(session.systemPrompt.join("\n")).toContain("HOST-TOGGLE-SECTION");
	});
});

// Extensions first loaded AT RUNTIME (extension_load tool / modes v2 enable
// direction) register through the session host, but their replay ledger must
// also land in the SESSION runtime — otherwise the disable→enable cycle
// (sdk.ts removeExtensionHostSections / replayExtensionHostSections) has no
// records to remove/replay and a failed HMR reload cannot restore the old
// host sections.
describe("prompt host ledger for runtime-loaded extensions", () => {
	const countOf = (text: string, needle: string): number => text.split(needle).length - 1;

	function runtimeLedgerExtSource(text: string): string {
		return `
export const name = "runtime-ledger-ext";
export function apply(pi) {
	pi.promptHost?.registerSection({
		name: "runtime-ledger-section",
		order: 25,
		text: ${JSON.stringify(text)},
	});
}
`;
	}

	it("keeps a replayable ledger when a pi.promptHost extension is first loaded at runtime", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-host-runtime-load-");
		const entry = tempDir.join("runtime-ledger-ext.ts");
		fs.writeFileSync(entry, runtimeLedgerExtSource("RUNTIME-LEDGER-SECTION"), "utf8");

		const { session, extensionsResult, promptHost } = await createAgentSession(baseSessionOptions());
		sessions.push(session);
		if (!promptHost) throw new Error("session prompt host missing");

		const load = await session.loadExtension(entry);
		expect(load.errors).toEqual([]);
		expect(session.systemPrompt.join("\n")).toContain("RUNTIME-LEDGER-SECTION");

		// The factory's records must live in the SESSION runtime so the
		// disable/enable lifecycle can replay them without re-running the
		// factory (same pattern the initial loader establishes).
		const owner = extensionHostOwner(entry);
		const ledger = extensionsResult.runtime.promptHostLedgers.get(owner);
		expect(ledger).toBeDefined();

		// Disable direction (sdk.ts removeExtensionHostSections).
		if (ledger) removeScopedPromptHostLedger(promptHost, owner, ledger);
		else promptHost.removeByOwner(owner);
		await session.refreshBaseSystemPrompt();
		expect(session.systemPrompt.join("\n")).not.toContain("RUNTIME-LEDGER-SECTION");

		// Enable direction (sdk.ts replayExtensionHostSections): replay must
		// restore exactly one copy, not zero and not a duplicate.
		if (ledger) replayPromptHostLedger(promptHost, owner, ledger);
		await session.refreshBaseSystemPrompt();
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("RUNTIME-LEDGER-SECTION");
		expect(countOf(prompt, "RUNTIME-LEDGER-SECTION")).toBe(1);
	});

	it("restores the old host sections when a runtime-loaded extension fails to reload", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-host-runtime-reload-");
		const entry = tempDir.join("runtime-ledger-ext.ts");
		fs.writeFileSync(entry, runtimeLedgerExtSource("RUNTIME-RELOAD-V1"), "utf8");

		const { session, promptHost } = await createAgentSession(baseSessionOptions());
		sessions.push(session);
		if (!promptHost) throw new Error("session prompt host missing");

		const load = await session.loadExtension(entry);
		expect(load.errors).toEqual([]);
		expect(session.systemPrompt.join("\n")).toContain("RUNTIME-RELOAD-V1");

		// A broken edit must not take the extension's host sections down: the
		// reload fails, the old instance stays live, and its contributions are
		// restored from the retained ledger.
		fs.writeFileSync(entry, "export default function (pi) { syntax error", "utf8");
		const reload = await session.reloadExtension(entry);
		expect(reload.errors.length).toBeGreaterThan(0);

		await session.refreshBaseSystemPrompt();
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("RUNTIME-RELOAD-V1");
		expect(countOf(prompt, "RUNTIME-RELOAD-V1")).toBe(1);
	});
});
