import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServersService } from "../../src/daemon/services/mcp-servers-service";
import { probeServer } from "../../src/mcp/client";
import { writeMCPConfigFile } from "../../src/mcp/config-writer";

/**
 * A probe is the only MCP path that talks to a server the user has not
 * installed yet, so it must (a) prove the handshake works, (b) release the
 * transport either way, and (c) report failure instead of throwing — the
 * connector form shows the reason beside the field. A by-name probe adds the
 * contract that the daemon, not the client, supplies the resolved config and
 * its credentials.
 */

const fixture = path.join(import.meta.dir, "fixtures", "stdio-probe-server.mjs");
const command = process.execPath;
const tempDirs: string[] = [];

/** Fresh user-scope mcp.json path; every probe writes only under the temp root. */
function userConfigFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-mcp-probe-"));
	tempDirs.push(dir);
	return path.join(dir, "mcp.json");
}

afterAll(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

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
		const both = await service.probe({ name: "no-target", url: "https://example.com/mcp", command });
		expect(both.ok).toBe(false);
		expect(both.error).toContain('exactly one of "url" or "command"');

		const unnamed = await service.probe({ command });
		expect(unnamed.ok).toBe(false);
		expect(unnamed.error?.length).toBeGreaterThan(0);
	});

	it("reaches a real server through the same helper as the client", async () => {
		const result = await service.probe({ name: "fixture", command, args: [fixture] });
		expect(result.ok).toBe(true);
		expect(result.toolNames).toEqual(["echo"]);
	});

	it("probes an installed stdio connector by name without form fields", async () => {
		const configPath = userConfigFile();
		await writeMCPConfigFile(configPath, {
			mcpServers: { fixture: { type: "stdio", command, args: [fixture] } },
		});
		const prepared: unknown[] = [];
		const byName = new McpServersService({
			userConfigPath: () => configPath,
			probeCwd: () => process.cwd(),
			probeManager: () => ({
				getServerConfig: () => undefined,
				async prepareConfig(config) {
					prepared.push(config);
					return config;
				},
			}),
		});

		const result = await byName.probe({ name: "fixture" });

		expect(result.ok).toBe(true);
		expect(result.toolNames).toEqual(["echo"]);
		// `args` came from the file, not the UI, and auth was resolved once.
		expect(prepared).toHaveLength(1);
		expect(prepared[0]).toEqual({ type: "stdio", command, args: [fixture] });
	});

	it("probes a catalog connector the manager discovered without a user entry", async () => {
		const configPath = userConfigFile();
		const prepared: unknown[] = [];
		const byName = new McpServersService({
			userConfigPath: () => configPath,
			probeCwd: () => "/workspace",
			probeManager: () => ({
				getServerConfig: name =>
					name === "connector:catalog" ? { type: "stdio", command, args: [fixture] } : undefined,
				async prepareConfig(config) {
					prepared.push(config);
					return config;
				},
			}),
		});

		const result = await byName.probe({ name: "connector:catalog" });

		expect(result.ok).toBe(true);
		expect(result.toolNames).toEqual(["echo"]);
		expect(prepared).toHaveLength(1);
	});

	it("reports unavailable credentials when no live manager exists", async () => {
		const configPath = userConfigFile();
		await writeMCPConfigFile(configPath, {
			mcpServers: { fixture: { type: "stdio", command, args: [fixture] } },
		});
		const byName = new McpServersService({
			userConfigPath: () => configPath,
			probeCwd: () => "/workspace",
			probeManager: () => undefined,
		});

		const result = await byName.probe({ name: "fixture" });

		// Never a bare connect: a token/OAuth connector would fail for the wrong
		// reason and the row would claim the configured connector is broken.
		expect(result.ok).toBe(false);
		expect(result.error).toContain("no live MCP manager");
	});

	it("names an unknown connector instead of connecting it", async () => {
		const configPath = userConfigFile();
		const byName = new McpServersService({
			userConfigPath: () => configPath,
			probeCwd: () => "/workspace",
			probeManager: () => undefined,
		});

		const result = await byName.probe({ name: "absent" });

		expect(result.ok).toBe(false);
		expect(result.error).toContain('"absent" is not configured');
	});
});
