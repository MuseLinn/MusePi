/**
 * McpServersService（用户级 mcp.json 连接器面）契约测试。
 *
 * 钉住的契约：
 *  1. add 只增不改：既有条目（含手写配置）原样保留；
 *  2. list 的 wire 摘要不含 headers/token——token 只落在本机 mcp.json；
 *  3. 坏 JSON 不静默清空，而是带明确理由失败；
 *  4. URL/命令/header/auth 的边界校验（注入、协议、二选一）；
 *  5. remove 只删目标名字，其他条目不动；
 *  6. 相对路径被拒，避免写到进程 cwd 下的伪配置。
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServersService } from "../src/daemon/services/mcp-servers-service";

interface StoredConfig {
	mcpServers?: Record<string, Record<string, unknown>>;
}

function newService(): { service: McpServersService; configPath: string } {
	const dir = mkdtempSync(join(tmpdir(), "musepi-mcp-servers-"));
	const configPath = join(dir, "mcp.json");
	return { service: new McpServersService({ userConfigPath: () => configPath }), configPath };
}

function readStored(configPath: string): StoredConfig {
	return JSON.parse(readFileSync(configPath, "utf8")) as StoredConfig;
}

describe("McpServersService", () => {
	it("adds a remote connector without dropping existing entries", async () => {
		const { service, configPath } = newService();
		writeFileSync(
			configPath,
			JSON.stringify({ mcpServers: { handwritten: { type: "stdio", command: "node", args: ["server.js"] } } }),
		);

		await service.add({ name: "linear", url: "https://mcp.linear.app/mcp", auth: { type: "oauth" } });

		const stored = readStored(configPath);
		expect(stored.mcpServers?.handwritten).toEqual({ type: "stdio", command: "node", args: ["server.js"] });
		expect(stored.mcpServers?.linear).toMatchObject({
			type: "http",
			url: "https://mcp.linear.app/mcp",
			auth: { type: "oauth" },
		});
	});

	it("stores a token header but never returns it from list", async () => {
		const { service, configPath } = newService();
		await service.add({
			name: "github",
			url: "https://api.githubcopilot.com/mcp/",
			headers: { Authorization: "Bearer ghp_exampleToken" },
		});

		const listed = await service.list();

		expect(listed.servers).toEqual([
			{ name: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/" },
		]);
		expect(JSON.stringify(listed)).not.toContain("ghp_exampleToken");
		// The token does live in the local config, which is user-scope state —
		// exactly where `/mcp add` would have put it.
		expect(readStored(configPath).mcpServers?.github?.headers).toEqual({
			Authorization: "Bearer ghp_exampleToken",
		});
	});

	it("keeps a stdio connector's command/args and reports its auth kind", async () => {
		const { service } = newService();
		await service.add({
			name: "local-tools",
			command: "bunx",
			args: ["@scope/server"],
			auth: { type: "apikey", credentialId: "cred-1" },
		});

		const listed = await service.list();

		expect(listed.servers).toEqual([{ name: "local-tools", transport: "stdio", command: "bunx", auth: "apikey" }]);
	});

	it("refuses a duplicate name instead of overwriting the existing entry", async () => {
		const { service } = newService();
		await service.add({ name: "linear", url: "https://mcp.linear.app/mcp" });

		await expect(service.add({ name: "linear", url: "https://mcp.notion.com/mcp" })).rejects.toThrow(
			/already exists/,
		);
	});

	it("rejects malformed JSON with the file context instead of starting over", async () => {
		const { service, configPath } = newService();
		writeFileSync(configPath, "{ not json");

		await expect(service.list()).rejects.toThrow(/Invalid user mcp\.json/);
		expect(readFileSync(configPath, "utf8")).toBe("{ not json");
	});

	it("rejects a syntactically valid file with the wrong shape", async () => {
		const { service, configPath } = newService();
		writeFileSync(configPath, JSON.stringify({ mcpServers: [] }));

		await expect(service.list()).rejects.toThrow(/mcpServers.*must be an object/);
	});

	it("validates the connector shape before touching the file", async () => {
		const { service, configPath } = newService();

		await expect(service.add({ name: "bad name", url: "https://mcp.example.com/mcp" })).rejects.toThrow();
		await expect(service.add({ name: "no-target" })).rejects.toThrow(/exactly one/);
		await expect(service.add({ name: "both", url: "https://mcp.example.com/mcp", command: "node" })).rejects.toThrow(
			/exactly one/,
		);
		await expect(service.add({ name: "ftp", url: "ftp://example.com/mcp" })).rejects.toThrow(/http or https/);
		await expect(service.add({ name: "rel", url: "/mcp" })).rejects.toThrow(/valid absolute URL/);
		await expect(
			service.add({ name: "inject", url: "https://mcp.example.com/mcp", headers: { "X-Key": "a\r\nX-Evil: 1" } }),
		).rejects.toThrow(/control characters/);
		await expect(
			service.add({ name: "badauth", url: "https://mcp.example.com/mcp", auth: { type: "basic" } }),
		).rejects.toThrow(/oauth/);
		expect(() => readStored(configPath)).toThrow();
	});

	it("removes only the named connector", async () => {
		const { service, configPath } = newService();
		await service.add({ name: "linear", url: "https://mcp.linear.app/mcp" });
		await service.add({ name: "notion", url: "https://mcp.notion.com/mcp" });

		await service.remove({ name: "linear" });

		expect(Object.keys(readStored(configPath).mcpServers ?? {})).toEqual(["notion"]);
		await expect(service.remove({ name: "missing" })).rejects.toThrow(/not found/);
	});

	it("rejects a relative config path", async () => {
		const service = new McpServersService({ userConfigPath: () => "mcp.json" });
		await expect(service.list()).rejects.toThrow(/absolute/);
	});

	it("reconciles live connectors after add and remove", async () => {
		const dir = mkdtempSync(join(tmpdir(), "musepi-mcp-reload-"));
		let reloads = 0;
		const service = new McpServersService({
			userConfigPath: () => join(dir, "mcp.json"),
			reloadConnectors: async () => {
				reloads += 1;
			},
		});

		await service.add({ name: "linear", url: "https://mcp.linear.app/mcp" });
		await service.remove({ name: "linear" });

		expect(reloads).toBe(2);
	});
});
