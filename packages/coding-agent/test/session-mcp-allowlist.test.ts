/**
 * M4 P1 连接器按会话白名单（SessionTools `#mcpServerAllowlist`）契约测试。
 *
 * 安全契约（docs/review/0.5.0-m4-experts-connectors-spec.md §4.2）：白名单在
 * daemon 侧生效——未配置（undefined）维持存量「连接即启用」；已配置（Set，
 * 可为空）仅名单内 server 的 MCP 工具进入激活集，其余留在注册表但不暴露；
 * 来源 server 未知的工具在名单生效时一律不放行（fail-closed）。客户端过滤
 * 不算安全边界，所以这里钉的是 SessionTools 激活集这一 daemon 权威面。
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@musepi/musepi-type";
import { Agent, type AgentTool } from "@musepi/pi-agent-core";
import type { Model } from "@musepi/pi-ai";
import { buildModel } from "@musepi/pi-catalog/build";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { CustomTool } from "@musepi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@musepi/pi-coding-agent/session/messages";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";

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

function createBasicTool(name: string, label: string): AgentTool {
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `${name} tool`,
		parameters: type({ q: "string" }),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

describe("M4 P1 per-session MCP connector allowlist", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		vi.restoreAllMocks();
	});

	function newSession(): AgentSession {
		const readTool = createBasicTool("read", "Read");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key" } as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			builtInToolNames: ["read"],
			ensureWriteRegistered: async () => false,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);
		return session;
	}

	const ALPHA_TOOLS = [createMcpCustomTool("mcp__alpha_search", "alpha", "search")];
	const BOTH_TOOLS = [...ALPHA_TOOLS, createMcpCustomTool("mcp__beta_run", "beta", "run")];

	it("undefined allowlist keeps the legacy all-on semantics (regression)", async () => {
		const session = newSession();
		await session.refreshMCPTools(BOTH_TOOLS);
		// Failure mode if regressed: every connected MCP tool is exposed even
		// though the session never configured a connector selection — the M4
		// whitelist would be silently inert on unconfigured sessions.
		expect(session.getSelectedMCPToolNames().sort()).toEqual(["mcp__alpha_search", "mcp__beta_run"]);
	});

	it("an allowlisted server exposes only its tools; others stay registered but unexposed", async () => {
		const session = newSession();
		await session.refreshMCPTools(BOTH_TOOLS);
		await session.setMCPServerAllowlist(["alpha"]);
		// Failure mode: beta's tool still reaches the model → cross-connector
		// tool leakage across the per-session boundary.
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__alpha_search"]);
		// …while the registry keeps beta registered (a later allowlist change
		// must be able to re-expose it without a reconnect).
		expect(session.getToolByName("mcp__beta_run")).toBeDefined();
	});

	it("an empty allowlist exposes zero MCP tools and never touches non-MCP tools", async () => {
		const session = newSession();
		await session.refreshMCPTools(BOTH_TOOLS);
		await session.setMCPServerAllowlist([]);
		// Failure mode: `[]` read as "unconfigured" would expose every
		// connected MCP tool — the exact boundary violation the empty state
		// exists to enforce.
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toContain("read");
	});

	it("the allowlist applies to tools that arrive AFTER it was set", async () => {
		const session = newSession();
		await session.setMCPServerAllowlist(["beta"]);
		await session.refreshMCPTools(BOTH_TOOLS);
		// Failure mode: a refresh re-enables everything connected (the old
		// refresh unconditionally activated manager tools) — late-arriving
		// servers would bypass the whitelist entirely.
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__beta_run"]);
	});

	it("a new server connecting while an allowlist is armed stays unexposed", async () => {
		const session = newSession();
		await session.refreshMCPTools(ALPHA_TOOLS);
		await session.setMCPServerAllowlist(["alpha"]);
		await session.refreshMCPTools([...ALPHA_TOOLS, createMcpCustomTool("mcp__gamma_list", "gamma", "list")]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__alpha_search"]);
	});

	it("clearing (null) restores the legacy all-on semantics", async () => {
		const session = newSession();
		await session.refreshMCPTools(BOTH_TOOLS);
		await session.setMCPServerAllowlist([]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		await session.setMCPServerAllowlist(null);
		expect(session.getSelectedMCPToolNames().sort()).toEqual(["mcp__alpha_search", "mcp__beta_run"]);
	});

	it("a manager tool with an unknown origin server is fail-closed under an allowlist", async () => {
		const session = newSession();
		const originless = {
			...createMcpCustomTool("mcp__delta_ping", "delta", "ping"),
		} as CustomTool & { mcpServerName?: string };
		// Simulate a provider that minted a tool WITHOUT origin metadata (the
		// whitelist's server mapping cannot resolve it).
		delete originless.mcpServerName;
		await session.refreshMCPTools([originless]);
		await session.setMCPServerAllowlist(["delta"]);
		// Failure mode: falling back to parseMCPToolName would expose the tool
		// based on a guess; the contract is fail-closed — unresolvable origin
		// means not on the list.
		expect(session.getSelectedMCPToolNames()).toEqual([]);
	});
});
