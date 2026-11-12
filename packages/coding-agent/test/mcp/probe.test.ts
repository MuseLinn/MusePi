import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { McpServersService } from "../../src/daemon/services/mcp-servers-service";
import { probeServer } from "../../src/mcp/client";

/**
 * A probe is the only MCP path that talks to a server the user has not
 * installed yet, so it must (a) prove the handshake works, (b) release the
 * transport either way, and (c) report failure instead of throwing — the
 * connector form shows the reason beside the field.
 */

const fixture = path.join(import.meta.dir, "fixtures", "stdio-probe-server.mjs");
const command = process.execPath;

describe("probeServer", () => {
	it("handshakes with a stdio server and reports the tools it serves", async () => {
		const result = await probeServer("fixture", { type: "stdio", command, args: [fixture] });
		expect(result.ok).toBe(true);
		expect(result.name).toBe("fixture");
		expect(result.serverInfo?.name).toBe("probe-fixture");
		expect(result.toolNames).toEqual(["echo"]);
		// No resources capability → the probe does not invent an empty list.
		expect(result.resourceCount).toBe(0);
	});

	it("reports a connection failure as a verdict, not an exception", async () => {
		const result = await probeServer("missing", {
			type: "stdio",
			command: path.join(import.meta.dir, "fixtures", "does-not-exist"),
		});
		expect(result.ok).toBe(false);
		expect(result.error?.length).toBeGreaterThan(0);
	});

	it("refuses an invalid config before spawning anything", async () => {
		const result = await probeServer("both", {
			type: "stdio",
			command,
			args: [],
			url: "https://example.com/mcp",
		} as never);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("both");
	});
});

describe("mcp.servers.probe service contract", () => {
	const service = new McpServersService({ userConfigPath: () => path.join(import.meta.dir, "unused-mcp.json") });

	it("validates the same inputs the install accepts and never throws", async () => {
		const missing = await service.probe({ name: "no-target" });
		expect(missing.ok).toBe(false);
		expect(missing.error).toContain('exactly one of "url" or "command"');

		const unnamed = await service.probe({ command });
		expect(unnamed.ok).toBe(false);
		expect(unnamed.error?.length).toBeGreaterThan(0);
	});

	it("reaches a real server through the same helper as the client", async () => {
		const result = await service.probe({ name: "fixture", command, args: [fixture] });
		expect(result.ok).toBe(true);
		expect(result.toolNames).toEqual(["echo"]);
	});
});
