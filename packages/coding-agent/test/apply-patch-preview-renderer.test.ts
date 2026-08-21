import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@musepi/musepi-type";
import { Agent, type AgentTool } from "@musepi/pi-agent-core";
import { createMockModel } from "@musepi/pi-ai/providers/mock";
import { buildModel } from "@musepi/pi-catalog/build";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";

function makeTool(name: string, customWireName?: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({}),
		...(customWireName ? { customWireName } : {}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

async function withSession(
	tools: readonly AgentTool[],
	builtInToolNames: readonly string[],
	run: (session: AgentSession) => void,
): Promise<void> {
	const tempDir = TempDir.createSync("@apply-patch-preview-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const settings = Settings.isolated({ "compaction.enabled": false });
	const model = buildModel({
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
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["initial"], tools: [...tools] },
		streamFn: createMockModel({ responses: [{ content: ["ok"] }] }).stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		toolRegistry: new Map<string, AgentTool>(tools.map(tool => [tool.name, tool])),
		builtInToolNames: [...builtInToolNames],
		rebuildSystemPrompt: async toolNames => ({ systemPrompt: [toolNames.join(",")] }),
	});
	try {
		run(session);
	} finally {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	}
}

/**
 * Regression #8184: the built-in `edit` tool presents on the wire as
 * `apply_patch` in apply_patch mode (`customWireName`). Tool cards render the
 * streamed call under that wire name, and the renderer registry is gated behind
 * `hasBuiltInTool(name)`. If the alias does not resolve to its built-in owner,
 * the edit renderer/preview is skipped for apply_patch-mode edits.
 */
describe("AgentSession.hasBuiltInTool wire-name aliases", () => {
	it("resolves a built-in tool's customWireName alias to built-in provenance", async () => {
		// Mirrors `edit` in apply_patch mode: internal name `edit`, wire name
		// `apply_patch`.
		const edit = makeTool("edit", "apply_patch");
		await withSession([edit], ["edit"], session => {
			expect(session.hasBuiltInTool("edit")).toBe(true);
			// The wire alias must resolve to its built-in owner so the edit
			// renderer/preview is used for apply_patch-mode cards.
			expect(session.hasBuiltInTool("apply_patch")).toBe(true);
		});
	});

	it("lets an extension registering the literal alias name shadow the built-in", async () => {
		// The agent loop routes exact-name matches ahead of wire aliases, so a
		// non-built-in tool registered under the literal `apply_patch` name wins;
		// it must not reuse the built-in edit renderer.
		const edit = makeTool("edit", "apply_patch");
		const shadow = makeTool("apply_patch");
		await withSession([edit, shadow], ["edit"], session => {
			expect(session.hasBuiltInTool("apply_patch")).toBe(false);
		});
	});
});
