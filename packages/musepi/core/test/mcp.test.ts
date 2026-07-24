// MusePi core — MCP 模块测试。
// 覆盖：JSON-RPC peer（请求/响应/通知/server 请求应答/超时）、桥接
// （命名空间化/冲突后缀/结果文本转换/配置解析）、registry（懒连接/
// 失败退避/重连/idle 回收/单 server 降级）、settings schema 合并——
// 集成部分用 fixtures/mock-mcp-server.mjs 假 server 走真实 stdio
// JSON-RPC。
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mergeMusepiSettings } from "../src/config/schema.ts";
import {
	bridgeMcpServerTools,
	JsonRpcPeer,
	McpClient,
	McpRegistry,
	mcpToolName,
	mcpToolResultToText,
	type McpTransport,
	resolveMcpServers,
	sanitizeMcpNamePart,
	StdioMcpTransport,
} from "../src/mcp/index.ts";

const FIXTURE_SERVER = fileURLToPath(new URL("./fixtures/mock-mcp-server.mjs", import.meta.url));

function mockServerConfig(name = "mock") {
	return {
		transport: "stdio" as const,
		name,
		command: process.execPath,
		args: [FIXTURE_SERVER],
	};
}

// =============================================================================
// naming / bridge
// =============================================================================

describe("bridge naming", () => {
	it("sanitizes name parts to [a-z0-9_]", () => {
		assert.strictEqual(sanitizeMcpNamePart("My Server!", "x"), "my_server");
		assert.strictEqual(sanitizeMcpNamePart("___", "fallback"), "fallback");
		assert.strictEqual(sanitizeMcpNamePart("a__b", "x"), "a_b");
	});

	it("namespaces tool names as mcp_<server>_<tool>", () => {
		assert.strictEqual(mcpToolName("GitHub", "Create Issue"), "mcp_github_create_issue");
	});

	it("bridges tools with default schema and prefixed description", () => {
		const bridged = bridgeMcpServerTools("srv", [{ name: "t1" }, { name: "t2", description: "does t2" }]);
		assert.strictEqual(bridged[0].name, "mcp_srv_t1");
		assert.deepStrictEqual(bridged[0].inputSchema, { type: "object", properties: {} });
		assert.strictEqual(bridged[1].description, "[MCP:srv] does t2");
		assert.strictEqual(bridged[0].description, "[MCP:srv] t1");
	});

	it("suffixes intra-server sanitize collisions deterministically", () => {
		const bridged = bridgeMcpServerTools("srv", [{ name: "a-b" }, { name: "a_b" }, { name: "a b" }]);
		assert.deepStrictEqual(
			bridged.map((t) => t.name),
			["mcp_srv_a_b", "mcp_srv_a_b_2", "mcp_srv_a_b_3"],
		);
		// Original names are preserved for tools/call.
		assert.deepStrictEqual(
			bridged.map((t) => t.toolName),
			["a-b", "a_b", "a b"],
		);
	});

	it("bridges weird names to callable agent names", () => {
		const bridged = bridgeMcpServerTools("mock", [{ name: "Weird Name!" }]);
		assert.strictEqual(bridged[0].name, "mcp_mock_weird_name");
		assert.strictEqual(bridged[0].toolName, "Weird Name!");
	});
});

describe("result conversion", () => {
	it("joins text items and flags errors", () => {
		const { text, isError } = mcpToolResultToText({
			content: [
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
			isError: true,
		});
		assert.strictEqual(text, "one\ntwo");
		assert.strictEqual(isError, true);
	});

	it("renders placeholders for binary content", () => {
		const { text } = mcpToolResultToText({ content: [{ type: "image", mimeType: "image/png", data: "..." }] });
		assert.match(text, /\[image: image\/png/);
	});

	it("falls back to structuredContent JSON", () => {
		const { text } = mcpToolResultToText({ structuredContent: { a: 1 } });
		assert.match(text, /"a": 1/);
	});
});

describe("server config resolution", () => {
	it("resolves stdio and http entries, skips disabled, flags invalid", () => {
		const { servers, invalid, disabled } = resolveMcpServers({
			a: { command: "npx", args: ["srv"] },
			b: { url: "http://localhost:8080/mcp", headers: { authorization: "x" } },
			c: { command: "npx", enabled: false },
			d: {},
			e: { command: "npx", url: "http://x" },
		});
		assert.deepStrictEqual(
			servers.map((s) => [s.name, s.transport]),
			[
				["a", "stdio"],
				["b", "http"],
			],
		);
		assert.deepStrictEqual(disabled, ["c"]);
		assert.strictEqual(invalid.length, 2);
	});
});

// =============================================================================
// JSON-RPC peer (in-memory transport)
// =============================================================================

/** Loopback transport pair: messages sent on one side arrive on the other. */
function loopbackPair(): { client: McpTransport; server: McpTransport } {
	let clientListener: ((m: never) => void) | null = null;
	let serverListener: ((m: never) => void) | null = null;
	const closeListeners: Array<() => void> = [];
	return {
		client: {
			send(m) {
				serverListener?.(m as never);
			},
			onMessage(l) {
				clientListener = l as never;
			},
			onClose(l) {
				closeListeners.push(l);
			},
			close() {
				for (const l of closeListeners) l();
			},
		},
		server: {
			send(m) {
				clientListener?.(m as never);
			},
			onMessage(l) {
				serverListener = l as never;
			},
			onClose() {},
			close() {},
		},
	};
}

describe("json-rpc peer", () => {
	it("correlates responses to requests", async () => {
		const { client, server } = loopbackPair();
		const peer = new JsonRpcPeer(client);
		server.onMessage((message) => {
			const request = message as { id: number; method: string; params?: { x: number } };
			server.send({ jsonrpc: "2.0", id: request.id, result: request.params!.x * 2 });
		});
		const result = await peer.request("double", { x: 21 });
		assert.strictEqual(result, 42);
	});

	it("rejects on JSON-RPC error responses", async () => {
		const { client, server } = loopbackPair();
		const peer = new JsonRpcPeer(client);
		server.onMessage((message) => {
			const request = message as { id: number };
			server.send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "nope" } });
		});
		await assert.rejects(peer.request("missing"), /MCP error -32601: nope/);
	});

	it("times out unanswered requests", async () => {
		const { client } = loopbackPair();
		const peer = new JsonRpcPeer(client);
		await assert.rejects(peer.request("slow", {}, { timeoutMs: 50 }), /timed out/);
	});

	it("answers server ping requests and reports notifications", async () => {
		const { client, server } = loopbackPair();
		const notifications: string[] = [];
		const peer = new JsonRpcPeer(client, {
			onNotification: (n) => notifications.push(n.method),
		});
		const answered: unknown[] = [];
		server.onMessage((message) => {
			const response = message as { id?: number; result?: unknown };
			if (response.id !== undefined) answered.push(response.result);
		});
		server.send({ jsonrpc: "2.0", id: 99, method: "ping" });
		server.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepStrictEqual(answered, [{}]);
		assert.deepStrictEqual(notifications, ["notifications/tools/list_changed"]);
	});

	it("rejects pending requests when the transport closes", async () => {
		const { client } = loopbackPair();
		const peer = new JsonRpcPeer(client);
		const pending = peer.request("never");
		client.close();
		await assert.rejects(pending, /closed/);
	});
});

// =============================================================================
// stdio transport + client integration (real child process)
// =============================================================================

describe("stdio client integration", () => {
	it("connects, paginates tools/list, and calls tools", async () => {
		const client = await McpClient.connect(mockServerConfig(), { cwd: os.tmpdir() });
		try {
			assert.strictEqual(client.status, "ready");
			assert.deepStrictEqual(client.serverInfo, { name: "mock-mcp", version: "1.0.0" });
			// Pagination: 2 + 2 tools across two pages.
			assert.strictEqual(client.tools.length, 4);
			const echo = await client.callTool("echo", { text: "hi" });
			assert.deepStrictEqual(echo.content, [{ type: "text", text: "echo:hi" }]);
			const fail = await client.callTool("fail", {});
			assert.strictEqual(fail.isError, true);
		} finally {
			await client.close();
		}
	});

	it("fails cleanly on a missing command", async () => {
		await assert.rejects(
			McpClient.connect(
				{ transport: "stdio", name: "ghost", command: "definitely-not-a-real-binary-xyz" },
				{ cwd: os.tmpdir() },
			),
		);
	});
});

// =============================================================================
// registry — lazy connect, backoff, reconnect, idle reap, degradation
// =============================================================================

describe("registry", () => {
	it("does not connect until first use (lazy)", async () => {
		const registry = new McpRegistry({ cwd: os.tmpdir() });
		registry.setServers([mockServerConfig()]);
		assert.strictEqual(registry.getClient("mock"), null);
		assert.strictEqual(registry.statuses()[0].status, "disconnected");
		const client = await registry.ensureConnected("mock");
		assert.strictEqual(client.status, "ready");
		assert.strictEqual(registry.getClient("mock"), client);
		await registry.shutdownAll();
	});

	it("shares one connect across concurrent callers", async () => {
		const registry = new McpRegistry({ cwd: os.tmpdir() });
		registry.setServers([mockServerConfig()]);
		const [a, b] = await Promise.all([registry.ensureConnected("mock"), registry.ensureConnected("mock")]);
		assert.strictEqual(a, b);
		await registry.shutdownAll();
	});

	it("negative-caches connect failures and reconnect clears them", async () => {
		const registry = new McpRegistry({ cwd: os.tmpdir() });
		registry.setServers([{ transport: "stdio", name: "ghost", command: "definitely-not-a-real-binary-xyz" }]);
		await assert.rejects(registry.ensureConnected("ghost"));
		// Second attempt hits the negative cache (same message class, no respawn).
		const status = registry.statuses()[0];
		assert.strictEqual(status.status, "error");
		assert.ok(status.lastError && status.lastError.length > 0);
		// A working server on the same registry is unaffected (degradation).
		registry.setServers([
			{ transport: "stdio", name: "ghost", command: "definitely-not-a-real-binary-xyz" },
			mockServerConfig(),
		]);
		const client = await registry.ensureConnected("mock");
		assert.strictEqual(client.status, "ready");
		const ghost = registry.statuses().find((s) => s.name === "ghost");
		assert.strictEqual(ghost?.status, "error");
		await registry.shutdownAll();
	});

	it("callTool connects lazily and errors name the server", async () => {
		const registry = new McpRegistry({ cwd: os.tmpdir() });
		registry.setServers([mockServerConfig()]);
		const result = await registry.callTool("mock", "echo", { text: "yo" });
		assert.deepStrictEqual(result.content, [{ type: "text", text: "echo:yo" }]);
		await assert.rejects(registry.callTool("nope", "x", {}), /MCP server "nope" is not configured/);
		await registry.shutdownAll();
	});

	it("reconnect re-enumerates tools and fires the change listener", async () => {
		const registry = new McpRegistry({ cwd: os.tmpdir() });
		registry.setServers([mockServerConfig()]);
		const changes: string[] = [];
		registry.onToolsChanged((name) => changes.push(name));
		await registry.ensureConnected("mock");
		const reconnected = await registry.reconnect("mock");
		assert.strictEqual(reconnected.status, "ready");
		assert.strictEqual(reconnected.tools.length, 4);
		assert.ok(changes.filter((n) => n === "mock").length >= 2);
		await registry.shutdownAll();
	});

	it("reaps idle clients", async () => {
		const registry = new McpRegistry({ cwd: os.tmpdir() });
		registry.setServers([mockServerConfig()]);
		const client = await registry.ensureConnected("mock");
		registry.setIdleTimeout(50);
		client.lastActivity = Date.now() - 10_000;
		const reaped = await registry.reapIdle();
		assert.deepStrictEqual(reaped, ["mock"]);
		assert.strictEqual(registry.getClient("mock"), null);
		await registry.shutdownAll();
	});
});

// =============================================================================
// settings schema merge
// =============================================================================

describe("mcp settings merge", () => {
	it("defaults to enabled with an empty server table", () => {
		const merged = mergeMusepiSettings(undefined);
		assert.deepStrictEqual(merged.mcp, {
			enabled: true,
			servers: {},
			idleTimeoutMs: 600_000,
			startupDiscovery: false,
		});
	});

	it("merges server entries, keeping only known fields", () => {
		const merged = mergeMusepiSettings({
			mcp: {
				enabled: false,
				idleTimeoutMs: 5_000,
				startupDiscovery: true,
				servers: {
					fs: { command: "npx", args: ["-y", "@mcp/fs"], env: { DEBUG: "1", BAD: 7 }, unknown: "drop" },
					web: { url: "http://localhost:9/mcp", headers: { a: "b" }, enabled: false },
					broken: "not-an-object",
				},
			} as never,
		});
		assert.strictEqual(merged.mcp.enabled, false);
		assert.strictEqual(merged.mcp.idleTimeoutMs, 5_000);
		assert.strictEqual(merged.mcp.startupDiscovery, true);
		assert.deepStrictEqual(merged.mcp.servers.fs, {
			command: "npx",
			args: ["-y", "@mcp/fs"],
			env: { DEBUG: "1" },
		});
		assert.deepStrictEqual(merged.mcp.servers.web, {
			url: "http://localhost:9/mcp",
			headers: { a: "b" },
			enabled: false,
		});
		assert.strictEqual(merged.mcp.servers.broken, undefined);
	});
});
