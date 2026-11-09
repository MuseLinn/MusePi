import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import type { Model } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { buildModel } from "@musepi/pi-catalog/build";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@musepi/pi-coding-agent/extensibility/extensions";
import { PromptComposer } from "@musepi/pi-coding-agent/prompts/composer";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

// P5 HMR v2 busy gate: a session-level extension reload requested while the
// session is streaming must be parked (single pending slot) and performed at
// the next idle agent_end — never half-replacing the tool surface mid-turn.

const ENTRY_PATH = "/extensions/hmr-ext.ts";

// The deferred reload is fire-and-forget (`void` on the agent_end drain), so no
// promise is exposed to await; polling the mock call is the only signal. Bounded
// and race-tolerant (2s cap, 10ms granularity) — deterministic timer control
// cannot work here because the drain runs on the session's real event pipeline.
async function pollUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("pollUntil: condition not met before timeout");
		await Bun.sleep(10);
	}
}

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

describe("AgentSession extension hot reload busy gate", () => {
	let session: AgentSession | undefined;
	let reloadExtension: ReturnType<typeof vi.fn>;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	function createSession(): { session: AgentSession; agent: Agent } {
		reloadExtension = vi.fn(async () => ({ removedTools: [], errors: [], deferred: false }));
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial-base"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: {
				reloadExtension,
				getRegisteredTool: () => undefined,
				getExtensionEntryMtimes: () => new Map(),
				hasHandlers: () => false,
				emit: async () => undefined,
			} as unknown as ExtensionRunner,
		});
		return { session: session!, agent };
	}

	it("parks the reload while streaming and defers to the next idle agent_end", async () => {
		const { session: s, agent } = createSession();

		// Busy: agent loop streaming.
		agent.state.isStreaming = true;
		const result = await s.reloadExtension(ENTRY_PATH);
		expect(result).toEqual({ removedTools: [], errors: [], deferred: true });
		expect(reloadExtension).not.toHaveBeenCalled();

		// Idle now; the parked reload performs on the next agent_end settle.
		agent.state.isStreaming = false;
		agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);
		await pollUntil(() => reloadExtension.mock.calls.length > 0);
		expect(reloadExtension).toHaveBeenCalledWith(ENTRY_PATH, expect.any(String));
	});

	it("reloads immediately when idle", async () => {
		const { session: s } = createSession();

		const result = await s.reloadExtension(ENTRY_PATH);
		expect(result).toEqual({ removedTools: [], errors: [], deferred: false });
		expect(reloadExtension).toHaveBeenCalledWith(ENTRY_PATH, expect.any(String));
	});

	it("returns an empty result without a runner", async () => {
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial-base"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: undefined,
		});

		expect(await session.reloadExtension(ENTRY_PATH)).toEqual({
			removedTools: [],
			errors: [],
			deferred: false,
		});
	});
});

// Prompt-only extensions (registerPrompt without tools) must reach a live
// session's base prompt on load/reload/removal — not just the next unrelated
// tool-driven rebuild.
describe("AgentSession prompt-only extension lifecycle", () => {
	let session: AgentSession | undefined;

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	const PROMPT_SOURCE = "ext:hmr-ext";

	function createPromptSession(options: { sections: Array<{ name: string; order: number; text: string }> }) {
		const composer = new PromptComposer();
		const extension: { promptSections: Array<{ name: string; order: number; text: string }> } = {
			promptSections: [...options.sections],
		};
		const addSections = (): void => {
			composer.removeBySource(PROMPT_SOURCE);
			for (const section of extension.promptSections) composer.add({ ...section, source: PROMPT_SOURCE });
		};
		addSections();
		let loaded = false;
		const runner = {
			async loadExtension() {
				loaded = true;
				return { addedTools: [], errors: [] };
			},
			async reloadExtension() {
				return { removedTools: [], errors: [] };
			},
			isExtensionLoaded: () => loaded,
			getExtensionByPath: () => extension,
			getRegisteredTool: () => undefined,
			getExtensionEntryMtimes: () => new Map(),
			hasHandlers: () => false,
			emit: async () => undefined,
		};
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: createModel(),
				systemPrompt: ["initial-base"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: runner as unknown as ExtensionRunner,
			rebuildSystemPrompt: async () => ({ systemPrompt: composer.compose(["core"]) }),
			onExtensionPromptSectionsChanged: () => addSections(),
			getPromptRevision: () => composer.revision,
		});
		const setSections = (sections: Array<{ name: string; order: number; text: string }>): void => {
			extension.promptSections = [...sections];
		};
		return { session: session!, agent, composer, setSections };
	}

	it("refreshes the live base prompt after a prompt-only reload", async () => {
		const { session: s, setSections } = createPromptSession({
			sections: [{ name: "hmr:greet", order: 10, text: "OLD" }],
		});
		await s.refreshBaseSystemPrompt();
		expect(s.systemPrompt).toEqual(["core", "OLD"]);

		setSections([{ name: "hmr:greet", order: 10, text: "NEW" }]);
		await s.reloadExtension(ENTRY_PATH);
		expect(s.systemPrompt).toEqual(["core", "NEW"]);
	});

	it("refreshes the live base prompt after loading a prompt-only extension", async () => {
		const { session: s, setSections } = createPromptSession({ sections: [] });
		await s.refreshBaseSystemPrompt();
		expect(s.systemPrompt).toEqual(["core"]);

		setSections([{ name: "hmr:greet", order: 10, text: "ADDED" }]);
		await s.loadExtension(ENTRY_PATH);
		expect(s.systemPrompt).toEqual(["core", "ADDED"]);
	});

	it("drops prompt sections when a reload removes them", async () => {
		const { session: s, setSections } = createPromptSession({
			sections: [{ name: "hmr:greet", order: 10, text: "GONE" }],
		});
		await s.refreshBaseSystemPrompt();
		expect(s.systemPrompt).toEqual(["core", "GONE"]);

		setSections([]);
		await s.reloadExtension(ENTRY_PATH);
		expect(s.systemPrompt).toEqual(["core"]);
	});

	it("refreshes the live base prompt after a deferred reload drains", async () => {
		const {
			session: s,
			agent,
			setSections,
		} = createPromptSession({
			sections: [{ name: "hmr:greet", order: 10, text: "OLD" }],
		});
		await s.refreshBaseSystemPrompt();
		expect(s.systemPrompt).toEqual(["core", "OLD"]);

		setSections([{ name: "hmr:greet", order: 10, text: "DEFERRED" }]);
		agent.state.isStreaming = true;
		expect(await s.reloadExtension(ENTRY_PATH)).toEqual({ removedTools: [], errors: [], deferred: true });
		agent.state.isStreaming = false;
		agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);

		await pollUntil(() => s.systemPrompt.join("|") === "core|DEFERRED");
	});

	it("refreshes the live base prompt after a deferred load drains", async () => {
		const { session: s, agent, setSections } = createPromptSession({ sections: [] });
		await s.refreshBaseSystemPrompt();
		expect(s.systemPrompt).toEqual(["core"]);

		setSections([{ name: "hmr:greet", order: 10, text: "DEFERRED-LOAD" }]);
		agent.state.isStreaming = true;
		expect(await s.loadExtension(ENTRY_PATH)).toEqual({ addedTools: [], errors: [], deferred: true });
		expect(s.systemPrompt).toEqual(["core"]);

		agent.state.isStreaming = false;
		agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);

		await pollUntil(() => s.systemPrompt.join("|") === "core|DEFERRED-LOAD");
	});

	it("rebuilds on a registry revision change with an unchanged tool set", async () => {
		const { session: s, composer } = createPromptSession({ sections: [] });
		await s.refreshBaseSystemPrompt();
		expect(s.systemPrompt).toEqual(["core"]);

		composer.registry.registerSection({ name: "registry:extra", order: 10, text: "EXTRA" }, "ext:registry");
		await s.setActiveToolsByName([]);
		expect(s.systemPrompt).toEqual(["core", "EXTRA"]);
	});
});

// The pending table is keyed by entry path: a package that contributes several
// entries must park every one of them, and repeated requests for one entry
// collapse to the newest operation. A single-slot park silently dropped all but
// the last entry, which is why this is asserted separately from the reload gate.
describe("AgentSession extension busy gate keeps every entry", () => {
	let session: AgentSession | undefined;
	const loaded = new Set<string>();
	const calls: Array<{ op: string; entryPath: string }> = [];

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		loaded.clear();
		calls.length = 0;
	});

	function createSession(): { session: AgentSession; agent: Agent } {
		const mock = createMockModel({ responses: [{ content: ["Done"] }] });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: createModel(), systemPrompt: ["initial-base"], tools: [], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const runner = {
			isExtensionLoaded: (entryPath: string) => loaded.has(path.resolve(entryPath)),
			loadExtension: async (entryPath: string) => {
				loaded.add(path.resolve(entryPath));
				calls.push({ op: "load", entryPath });
				return { addedTools: [], errors: [] };
			},
			reloadExtension: async (entryPath: string) => {
				calls.push({ op: "reload", entryPath });
				return { removedTools: [], errors: [] };
			},
			removeExtension: (entryPath: string) => {
				loaded.delete(path.resolve(entryPath));
				calls.push({ op: "unload", entryPath });
				return [];
			},
			getRegisteredTool: () => undefined,
			getExtensionEntryMtimes: () => new Map(),
			getExtensionPaths: () => [...loaded],
			hasHandlers: () => false,
			emit: async () => undefined,
		} as unknown as ExtensionRunner;
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			extensionRunner: runner,
		});
		return { session: session!, agent };
	}

	it("parks every entry of a multi-entry install and applies them in order", async () => {
		const { session: s, agent } = createSession();
		agent.state.isStreaming = true;
		await s.loadExtension("/extensions/pkg/a.ts");
		await s.loadExtension("/extensions/pkg/b.ts");
		expect(calls).toHaveLength(0);

		agent.state.isStreaming = false;
		agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);

		await pollUntil(() => calls.length === 2);
		expect(calls.map(call => [path.basename(call.entryPath), call.op])).toEqual([
			["a.ts", "load"],
			["b.ts", "load"],
		]);
	});

	it("collapses a load then unload of the same entry to the newest operation", async () => {
		const { session: s, agent } = createSession();
		loaded.add(path.resolve("/extensions/pkg/a.ts"));
		agent.state.isStreaming = true;

		await s.reloadExtension("/extensions/pkg/a.ts");
		await s.unloadExtension("/extensions/pkg/a.ts");
		agent.state.isStreaming = false;
		agent.emitExternalEvent({ type: "agent_end", messages: [] } as never);

		await pollUntil(() => calls.length === 1);
		expect(calls).toEqual([{ op: "unload", entryPath: path.resolve("/extensions/pkg/a.ts") }]);
		expect(loaded.has(path.resolve("/extensions/pkg/a.ts"))).toBe(false);
	});

	it("unloads an idle entry and drops it from the loaded set", async () => {
		const { session: s } = createSession();
		loaded.add(path.resolve("/extensions/pkg/a.ts"));

		const result = await s.unloadExtension("/extensions/pkg/a.ts");

		expect(result).toEqual({ removedTools: [], errors: [], deferred: false });
		expect(calls[0]?.op).toBe("unload");
	});
});
