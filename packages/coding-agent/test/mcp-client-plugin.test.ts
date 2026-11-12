import { describe, expect, it } from "bun:test";
import { serverConfigFromRow } from "../src/bundled-plugins/mcp-client/index";

describe("musepi-mcp-client row config", () => {
	it("is inert without a server name (an accidental ambient mount invents nothing)", () => {
		expect(serverConfigFromRow({})).toBeNull();
		expect(serverConfigFromRow({ serverName: "  " })).toBeNull();
	});

	it("keeps a disabled row unconnected", () => {
		expect(serverConfigFromRow({ serverName: "demo", enabled: false, command: "node" })).toBeNull();
	});

	it("builds a stdio server with parsed args and env", () => {
		expect(
			serverConfigFromRow({
				serverName: "github",
				command: "npx",
				args: '["-y","@modelcontextprotocol/server-github"]',
				env: '{"GITHUB_TOKEN":"x"}',
				timeout: 45000,
			}),
		).toEqual({
			serverName: "github",
			config: {
				type: "stdio",
				command: "npx",
				args: ["-y", "@modelcontextprotocol/server-github"],
				env: { GITHUB_TOKEN: "x" },
				timeout: 45000,
			},
		});
	});

	it("builds HTTP and SSE servers from url + headers", () => {
		expect(
			serverConfigFromRow({
				serverName: "web",
				transport: "http",
				url: "http://localhost:3000/mcp",
				headers: '{"Authorization":"Bearer t"}',
			}),
		).toEqual({
			serverName: "web",
			config: { type: "http", url: "http://localhost:3000/mcp", headers: { Authorization: "Bearer t" } },
		});
		expect(serverConfigFromRow({ serverName: "sse", transport: "sse", url: "http://x/sse" })?.config).toEqual({
			type: "sse",
			url: "http://x/sse",
		});
	});

	it("rejects a half-configured row with the reason instead of connecting", () => {
		expect(() => serverConfigFromRow({ serverName: "stdio-no-command" })).toThrow("command is required");
		expect(() => serverConfigFromRow({ serverName: "http-no-url", transport: "http" })).toThrow("url is required");
		expect(() => serverConfigFromRow({ serverName: "bad-args", command: "node", args: "{oops" })).toThrow(
			"args is not valid JSON",
		);
		expect(() => serverConfigFromRow({ serverName: "bad-env", command: "node", env: '["x"]' })).toThrow(
			"env must be a JSON object",
		);
	});
});
