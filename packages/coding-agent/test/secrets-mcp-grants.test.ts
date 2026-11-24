import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MCPServerConfig } from "@musepi/pi-coding-agent/mcp/types";
import { MCPManager } from "@musepi/pi-coding-agent/mcp/manager";
import { AgentSecretStore } from "@musepi/pi-coding-agent/secrets/agent-store";
import {
	listMcpGrants,
	mcpGrantedKeys,
	mcpServerTarget,
	setMcpGrant,
} from "@musepi/pi-coding-agent/secrets/mcp-grants";
import { getAgentDir, setAgentDir } from "@musepi/pi-utils/dirs";

const original = getAgentDir();

afterAll(() => {
	setAgentDir(original);
});

function freshAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "musepi-mcp-grants-"));
	setAgentDir(dir);
	return dir;
}

const STDIO = { type: "stdio" as const, command: "npx", args: ["-y", "demo-mcp"] };

/** The union is narrowed where the test reads a transport-specific field. */
function envOf(config: MCPServerConfig): Record<string, string> | undefined {
	return "env" in config ? config.env : undefined;
}

function headersOf(config: MCPServerConfig): Record<string, string> | undefined {
	return "headers" in config ? config.headers : undefined;
}

describe("MCP grant store", () => {
	it("fingerprints the endpoint, not just the name", () => {
		expect(mcpServerTarget(STDIO)).toBe(mcpServerTarget({ ...STDIO, args: ["-y", "demo-mcp"] }));
		// A different argument or URL is a different endpoint.
		expect(mcpServerTarget(STDIO)).not.toBe(mcpServerTarget({ ...STDIO, args: ["-y", "other-mcp"] }));
		expect(mcpServerTarget({ type: "http", url: "https://a.example/mcp" })).not.toBe(
			mcpServerTarget({ type: "http", url: "https://b.example/mcp" }),
		);
	});

	it("records names per server and endpoint, and drops them when the endpoint changes", async () => {
		const dir = freshAgentDir();
		await setMcpGrant(dir, "demo", mcpServerTarget(STDIO), ["GITHUB_TOKEN", "STRIPE_KEY"]);

		expect(await mcpGrantedKeys(dir, "demo", mcpServerTarget(STDIO))).toEqual(["GITHUB_TOKEN", "STRIPE_KEY"]);
		expect(await mcpGrantedKeys(dir, "demo", mcpServerTarget({ ...STDIO, args: ["-y", "evil"] }))).toEqual([]);
		expect(await listMcpGrants(dir)).toEqual([
			{ server: "demo", target: mcpServerTarget(STDIO), keys: ["GITHUB_TOKEN", "STRIPE_KEY"] },
		]);

		// An empty list revokes the server entirely.
		await setMcpGrant(dir, "demo", mcpServerTarget(STDIO), []);
		expect(await listMcpGrants(dir)).toEqual([]);
	});

	it("refuses an invalid server name or secret name", async () => {
		const dir = freshAgentDir();
		await expect(setMcpGrant(dir, "", mcpServerTarget(STDIO), ["GITHUB_TOKEN"])).rejects.toThrow(/server name/u);
		await expect(setMcpGrant(dir, "demo", mcpServerTarget(STDIO), ["lower_case"])).rejects.toThrow(
			/Invalid secret name/u,
		);
	});
});

describe("MCP vault references require a grant", () => {
	it("drops an ungranted reference and resolves a granted one", async () => {
		const dir = freshAgentDir();
		await new AgentSecretStore(dir).set("MCP_TOKEN", "abc/def", "an MCP server");

		const manager = new MCPManager(dir);
		const config = { ...STDIO, env: { TOKEN: "${vault:MCP_TOKEN}" } };

		expect(envOf(await manager.prepareConfig(config, { serverName: "demo" }))?.TOKEN).toBeUndefined();
		// Without a server name nothing can be granted, so the value stays out.
		expect(envOf(await manager.prepareConfig(config))?.TOKEN).toBeUndefined();

		await setMcpGrant(dir, "demo", mcpServerTarget(config), ["MCP_TOKEN"]);
		expect(envOf(await manager.prepareConfig(config, { serverName: "demo" }))?.TOKEN).toBe("abc/def");
		// The same grant does not travel to a differently-pointing server entry.
		const moved = { ...STDIO, args: ["-y", "other-mcp"], env: { TOKEN: "${vault:MCP_TOKEN}" } };
		expect(envOf(await manager.prepareConfig(moved, { serverName: "demo" }))?.TOKEN).toBeUndefined();
	});

	it("applies the same rule to headers of an HTTP server", async () => {
		const dir = freshAgentDir();
		await new AgentSecretStore(dir).set("MCP_TOKEN", "abc/def", "an MCP server");
		const manager = new MCPManager(dir);
		const config = {
			type: "http" as const,
			url: "https://mcp.example/api",
			headers: { Authorization: "${vault:MCP_TOKEN}" },
		};

		expect(headersOf(await manager.prepareConfig(config, { serverName: "demo" }))?.Authorization).toBeUndefined();
		await setMcpGrant(dir, "demo", mcpServerTarget(config), ["MCP_TOKEN"]);
		expect(headersOf(await manager.prepareConfig(config, { serverName: "demo" }))).toEqual({
			Authorization: "abc/def",
		});
	});
});
