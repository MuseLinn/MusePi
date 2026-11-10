/**
 * PromptHost.registerContext real session delivery (core prompt pluginization,
 * context-delivery task).
 *
 * Contract: the SDK wires `collectPromptContexts` to `promptHost.collectContext`
 * with the same render inputs the assembly used (activeTools + toolRefs-bearing
 * context). AgentSession collects at every prompt-assembly site and converts
 * each delivered context into a hidden `role:"custom"`,
 * `customType:"prompt-context:<name>"` message on the normal
 * persistence/provider pipeline. Required contexts deliver every turn;
 * non-required contexts dedupe against the latest delivered copy of the same
 * customType (so resumed/branched history never stacks duplicates) and a real
 * content change appends the newest text exactly once. Disable/re-enable and
 * owner release follow the existing ledger semantics; a disposed (closed) host
 * collects nothing. Contributions may opt out of `{{name}}` interpolation so
 * arbitrary user text stays literal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@musepi/pi-agent-core";
import { type Api, type Context, clearCustomApis, type Model, type ModelSpec, registerCustomApi } from "@musepi/pi-ai";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@musepi/pi-ai/utils/event-stream";
import { buildModel } from "@musepi/pi-catalog/build";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { PromptHost } from "@musepi/pi-coding-agent/prompts/host";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import type { CustomMessage, CustomMessageContent } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const PROMPT_CONTEXT_PREFIX = "prompt-context:";

function contentText(content: CustomMessageContent): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("\n\n");
}

function promptContexts(messages: AgentMessage[], name: string): CustomMessage[] {
	const customType = `${PROMPT_CONTEXT_PREFIX}${name}`;
	return messages.filter(
		(message): message is CustomMessage => message.role === "custom" && message.customType === customType,
	);
}

describe("AgentSession prompt-context delivery (real session lifecycle)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prompt-context-delivery-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(turns: number, collect: () => ReturnType<PromptHost["collectContext"]>): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model");
		const mock = createMockModel({
			responses: Array.from({ length: turns }, () => ({ content: ["Done"] })),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
			rebuildSystemPrompt: async () => ({ systemPrompt: ["Test"] }),
			collectPromptContexts: collect,
		});
		sessions.push(session);
		return session;
	}

	it("delivers a non-required context once, skips the unchanged rebuild, and re-delivers a change", async () => {
		const host = new PromptHost();
		let contextText = "EXT-CTX-V1";
		const dispose = host.registerContext({ name: "ext-ctx", text: () => contextText });
		const session = createSession(4, () => host.collectContext());

		await session.prompt("first turn");
		const first = promptContexts(session.messages, "ext-ctx");
		expect(first).toHaveLength(1);
		expect(contentText(first[0]!.content)).toBe("EXT-CTX-V1");
		expect(first[0]!.display).toBe(false);

		await session.prompt("second turn");
		expect(promptContexts(session.messages, "ext-ctx")).toHaveLength(1);

		contextText = "EXT-CTX-V2";
		await session.prompt("changed turn");
		const afterChange = promptContexts(session.messages, "ext-ctx");
		expect(afterChange).toHaveLength(2);
		expect(contentText(afterChange[1]!.content)).toBe("EXT-CTX-V2");

		await session.prompt("unchanged turn");
		expect(promptContexts(session.messages, "ext-ctx")).toHaveLength(2);

		dispose();
		await session.prompt("after dispose");
		expect(promptContexts(session.messages, "ext-ctx")).toHaveLength(2);
	});

	it("re-delivers unchanged context after compaction removes its previous message from live history", async () => {
		const host = new PromptHost();
		host.registerContext({ name: "compact-ctx", text: "COMPACT-CTX" });
		const session = createSession(2, () => host.collectContext({ recordDelivery: false }));

		await session.prompt("before compaction");
		expect(promptContexts(session.messages, "compact-ctx")).toHaveLength(1);
		session.agent.replaceMessages([]);
		await session.prompt("after compaction");
		expect(promptContexts(session.messages, "compact-ctx")).toHaveLength(1);
	});

	it("carries owner/lane/cacheScope in details and attributes the message to the agent", async () => {
		const host = new PromptHost();
		host.registerContext({
			name: "meta-ctx",
			text: "META-CTX",
			cacheScope: "snapshot",
			owner: "meta-owner",
		});
		const session = createSession(1, () => host.collectContext());

		await session.prompt("only turn");
		const [message] = promptContexts(session.messages, "meta-ctx");
		if (!message) throw new Error("Expected prompt-context message");
		expect(message.details).toMatchObject({ owner: "meta-owner", cacheScope: "snapshot" });
		expect((message.details as { lane?: string }).lane).toBe("core");
		expect(message.attribution).toBe("agent");
	});

	it("delivers a required context every turn", async () => {
		const host = new PromptHost();
		host.registerContext({ name: "req-ctx", text: "REQ-CTX", required: true });
		const session = createSession(3, () => host.collectContext());

		await session.prompt("first turn");
		await session.prompt("second turn");
		await session.prompt("third turn");
		expect(promptContexts(session.messages, "req-ctx")).toHaveLength(3);
	});

	it("does not re-deliver a non-required context collected by a fresh host over resumed history", async () => {
		// Simulates resume/branch: a fresh PromptHost (empty delivery ledger)
		// collects the same non-required context the persisted history already
		// carries. The latest-custom comparison must suppress the copy.
		const host = new PromptHost();
		host.registerContext({ name: "resume-ctx", text: "RESUME-CTX" });
		let collect: () => ReturnType<PromptHost["collectContext"]> = () => host.collectContext();
		const session = createSession(2, () => collect());

		await session.prompt("first turn");
		expect(promptContexts(session.messages, "resume-ctx")).toHaveLength(1);

		const freshHost = new PromptHost();
		freshHost.registerContext({ name: "resume-ctx", text: "RESUME-CTX" });
		collect = () => freshHost.collectContext();
		await session.prompt("resumed turn");
		expect(promptContexts(session.messages, "resume-ctx")).toHaveLength(1);
	});

	it("re-delivers a changed non-required context collected by a fresh host over resumed history", async () => {
		const host = new PromptHost();
		host.registerContext({ name: "resume-change-ctx", text: "RESUME-CHANGE-V1" });
		let collect: () => ReturnType<PromptHost["collectContext"]> = () => host.collectContext();
		const session = createSession(2, () => collect());

		await session.prompt("first turn");
		expect(promptContexts(session.messages, "resume-change-ctx")).toHaveLength(1);

		const freshHost = new PromptHost();
		freshHost.registerContext({ name: "resume-change-ctx", text: "RESUME-CHANGE-V2" });
		collect = () => freshHost.collectContext();
		await session.prompt("resumed turn");
		const contexts = promptContexts(session.messages, "resume-change-ctx");
		expect(contexts).toHaveLength(2);
		expect(contentText(contexts[1]!.content)).toBe("RESUME-CHANGE-V2");
	});

	it("keeps literal braces when interpolate is false instead of throwing on unknown variables", async () => {
		const host = new PromptHost();
		host.registerContext({
			name: "literal-ctx",
			text: () => "USER TEXT {{unknown}} {{also.unknown}}",
			interpolate: false,
		});
		const session = createSession(1, () => host.collectContext());

		await session.prompt("only turn");
		const [message] = promptContexts(session.messages, "literal-ctx");
		if (!message) throw new Error("Expected prompt-context message");
		expect(contentText(message.content)).toBe("USER TEXT {{unknown}} {{also.unknown}}");
	});

	it("interpolates known variables by default and stops collecting after owner release", async () => {
		const host = new PromptHost();
		host.registerContext({ name: "var-ctx", text: () => "VALUE={{known}}" });
		host.registerVariable("known", () => "42");
		const session = createSession(2, () => host.collectContext());

		await session.prompt("first turn");
		const [message] = promptContexts(session.messages, "var-ctx");
		if (!message) throw new Error("Expected prompt-context message");
		expect(contentText(message.content)).toBe("VALUE=42");

		host.removeByOwner("host");
		await session.prompt("after release");
		expect(promptContexts(session.messages, "var-ctx")).toHaveLength(1);
	});
});

describe("SDK wires collectPromptContexts through createAgentSession", () => {
	const api = "test-prompt-context-sdk";
	const contexts: Context[] = [];

	beforeEach(() => {
		registerCustomApi(api, (_model, context) => {
			contexts.push(context);
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("ok");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
	});

	afterEach(() => {
		clearCustomApis();
		contexts.length = 0;
	});

	function buildMockModel(): Model<Api> {
		return buildModel({
			id: "prompt-context-sdk",
			name: "Prompt context SDK",
			api,
			provider: "managed-primary",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
	}

	function baseOptions(tempDir: TempDir, authStorage: AuthStorage, modelRegistry: ModelRegistry) {
		return {
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			profileHome: tempDir.path(),
			modelRegistry,
			authStorage,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildMockModel(),
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

	it("collects contexts on the real entry with the assembly's toolRefs, non-required deduped, change re-delivered", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-context-sdk-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		let contextVersion = 1;
		try {
			const { session, promptHost } = await createAgentSession({
				...baseOptions(tempDir, authStorage, modelRegistry),
				extensions: [
					pi => {
						pi.on("session_start", () => {
							pi.promptHost?.registerContext({
								name: "sdk-ctx",
								text: context =>
									`SDK-CTX-V${contextVersion}[${String((context as { toolRefs?: Record<string, string> }).toolRefs?.read)}]`,
							});
						});
					},
				],
			});
			try {
				expect(promptHost).toBeDefined();
				await session.prompt("first turn");
				const first = promptContexts(session.messages, "sdk-ctx");
				expect(first).toHaveLength(1);
				// The context text saw the same toolRefs the assembly used.
				expect(contentText(first[0]!.content)).toBe("SDK-CTX-V1[read]");
				expect(first[0]!.display).toBe(false);
				expect(contexts.some(context => JSON.stringify(context.messages).includes("SDK-CTX-V1[read]"))).toBe(true);

				await session.prompt("second turn");
				expect(promptContexts(session.messages, "sdk-ctx")).toHaveLength(1);

				contextVersion = 2;
				await session.prompt("third turn");
				const changed = promptContexts(session.messages, "sdk-ctx");
				expect(changed).toHaveLength(2);
				expect(contentText(changed[1]!.content)).toBe("SDK-CTX-V2[read]");
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("delivers a required context every turn through the SDK entry", async () => {
		using tempDir = TempDir.createSync("@pi-prompt-context-sdk-req-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		try {
			const { session, promptHost } = await createAgentSession({
				...baseOptions(tempDir, authStorage, modelRegistry),
				extensions: [
					pi => {
						pi.on("session_start", () => {
							pi.promptHost?.registerContext({ name: "sdk-req", text: "SDK-REQ", required: true });
						});
					},
				],
			});
			try {
				expect(promptHost).toBeDefined();
				await session.prompt("first turn");
				await session.prompt("second turn");
				expect(promptContexts(session.messages, "sdk-req")).toHaveLength(2);
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});
});
