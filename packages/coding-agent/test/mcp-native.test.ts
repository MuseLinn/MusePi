// MusePi MCP host seam — integration tests.
//
// Runs the real pipeline: settings → initMusepiMcp (via createAgentSession)
// → /mcp reconnect against a mock stdio MCP server (newline-delimited
// JSON-RPC child process) → dynamic tool registration → tool execution.
// Covers laziness (no connect before first use), namespacing, graceful
// degradation for a broken server, and the tool-list cache round-trip.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import { permissionManager } from "@musepi/core/permission/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { handleMusepiMcpCommand, shutdownMusepiMcp, shutdownMusepiMcpConnections } from "../src/musepi/mcp-native.ts";
import { musepiSelectToolsToolDef, transformMusepiToolSelectContext } from "../src/musepi/tool-select-native.ts";

const FIXTURE_SERVER = fileURLToPath(new URL("../../musepi/core/test/fixtures/mock-mcp-server.mjs", import.meta.url));

let tempDir: string;
let agentDir: string;
let previousAgentDirEnv: string | undefined;

function writeSettings(musepi: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ musepi }));
}

async function createSession(): Promise<AgentSession> {
	// The full app entry: services + FromServices wires the musepi custom
	// tools (select_tools, lsp, …) — sdk.createAgentSession alone does not.
	const services = await createAgentSessionServices({ cwd: tempDir, agentDir });
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(),
		model: getModel("anthropic", "claude-sonnet-4-5")!,
	});
	return session;
}

beforeEach(() => {
	tempDir = join(tmpdir(), `musepi-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	previousAgentDirEnv = process.env[ENV_AGENT_DIR];
	process.env[ENV_AGENT_DIR] = agentDir;
	// MCP calls are gated by the shared permission chain; tests run
	// unattended (no approval dialog), so approve-by-default.
	permissionManager.setMode("yolo");
});

afterEach(async () => {
	// Close connections BEFORE the binding is dropped (it owns the registry).
	await shutdownMusepiMcpConnections();
	shutdownMusepiMcp();
	permissionManager.setMode("manual");
	if (previousAgentDirEnv === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDirEnv;
	if (tempDir && existsSync(tempDir)) {
		// Windows: just-killed MCP children release their cwd asynchronously.
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
		}
	}
});

describe("musepi mcp — lazy lifecycle", () => {
	it("does not connect at session start; /mcp list shows disconnected", async () => {
		writeSettings({
			mcp: { servers: { mock: { command: process.execPath, args: [FIXTURE_SERVER] } } },
		});
		const session = await createSession();
		try {
			expect(session.getDynamicToolNames()).toEqual([]);
			const output = await handleMusepiMcpCommand("list");
			expect(output).toContain("mock [stdio] disconnected");
		} finally {
			await session.dispose();
		}
	});

	it("/mcp reconnect connects, enumerates, and registers namespaced tools", async () => {
		writeSettings({
			mcp: { servers: { mock: { command: process.execPath, args: [FIXTURE_SERVER] } } },
		});
		const session = await createSession();
		try {
			const output = await handleMusepiMcpCommand("reconnect mock");
			expect(output).toContain("mock: connected · 4 tools");
			const dynamic = session.getDynamicToolNames();
			expect(dynamic).toContain("mcp_mock_echo");
			expect(dynamic).toContain("mcp_mock_weird_name"); // sanitized
			// toolSelect gate is off by default → tools activate directly.
			expect(session.getActiveToolNames()).toContain("mcp_mock_echo");
			const status = await handleMusepiMcpCommand("status");
			expect(status).toContain("connected · 4 tools");
		} finally {
			await session.dispose();
		}
	});

	it("a broken server degrades gracefully and never blocks the session", async () => {
		writeSettings({
			mcp: {
				servers: {
					ghost: { command: "definitely-not-a-real-binary-xyz" },
					mock: { command: process.execPath, args: [FIXTURE_SERVER] },
				},
			},
		});
		const session = await createSession();
		try {
			const output = await handleMusepiMcpCommand("reconnect");
			expect(output).toMatch(/ghost: .*closed|ghost: .*error|ghost: .*spawn/i);
			expect(output).toContain("mock: connected · 4 tools");
			const status = await handleMusepiMcpCommand("list");
			expect(status).toContain("ghost [stdio] error:");
		} finally {
			await session.dispose();
		}
	});

	it("registers tools from cache on the next session without connecting", async () => {
		writeSettings({
			mcp: { servers: { mock: { command: process.execPath, args: [FIXTURE_SERVER] } } },
		});
		const first = await createSession();
		try {
			await handleMusepiMcpCommand("reconnect mock");
			expect(first.getDynamicToolNames()).toContain("mcp_mock_echo");
		} finally {
			await first.dispose();
		}
		// Drop the warm connection but keep the binding (registry is reused
		// across sessions in-process, LSP pattern); the next session must
		// come up disconnected and register from the cache alone.
		await shutdownMusepiMcpConnections();

		// Second session: tools come back from the cache with NO connection.
		const second = await createSession();
		try {
			expect(second.getDynamicToolNames()).toContain("mcp_mock_echo");
			const output = await handleMusepiMcpCommand("list");
			expect(output).toContain("disconnected");
			expect(output).toContain("registered from cache");
		} finally {
			await second.dispose();
		}
	});
});

describe("musepi mcp — W7 deferred coordination", () => {
	it("toolSelect on: MCP tools join the deferred loadable set, not the top-level tools[]", async () => {
		writeSettings({
			mcp: { servers: { mock: { command: process.execPath, args: [FIXTURE_SERVER] } } },
			toolSelect: { enabled: true, models: ["claude-sonnet-4-5"] },
		});
		const session = await createSession();
		try {
			await handleMusepiMcpCommand("reconnect mock");
			// Registered (known to the session) but NOT active — deferred.
			expect(session.getDynamicToolNames()).toContain("mcp_mock_echo");
			expect(session.getActiveToolNames()).not.toContain("mcp_mock_echo");
			expect(session.getActiveToolNames()).toContain("select_tools");
			// The announcement transformer lists them as loadable.
			const messages = transformMusepiToolSelectContext([] as { role: string }[]);
			expect(messages.length).toBe(1);
			const text = JSON.stringify(messages[0]);
			expect(text).toContain("mcp_mock_echo");
			// Loading through select_tools activates them for real calls.
			const result = await musepiSelectToolsToolDef.execute(
				"tc-1",
				{ names: ["mcp_mock_echo"] },
				undefined,
				undefined,
				{} as never,
			);
			expect(JSON.stringify(result.content)).toContain("mcp_mock_echo");
			expect(session.getActiveToolNames()).toContain("mcp_mock_echo");
		} finally {
			await session.dispose();
		}
	});
});

describe("musepi mcp — master switch", () => {
	it("disabled config answers politely and registers nothing", async () => {
		writeSettings({
			mcp: { enabled: false, servers: { mock: { command: process.execPath, args: [FIXTURE_SERVER] } } },
		});
		const session = await createSession();
		try {
			expect(session.getDynamicToolNames()).toEqual([]);
			const output = await handleMusepiMcpCommand("list");
			expect(output).toContain("disabled");
		} finally {
			await session.dispose();
		}
	});
});
