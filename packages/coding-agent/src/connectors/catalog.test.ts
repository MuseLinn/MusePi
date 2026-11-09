import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { loadConnectorCatalog } from "./catalog";

async function tempAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), "musepi-connector-catalog-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

describe("connector catalog", () => {
	it("prefers index entries and normalizes package directories", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "catalog.json"), {
			version: 1,
			connectors: [
				{
					id: "alpha",
					name: "Alpha (index)",
					description: "from the index",
					server: { type: "http", url: "https://alpha.example/mcp" },
					auth: { mode: "none" },
				},
				{
					id: "beta",
					name: "Beta",
					description: "remote",
					server: { type: "sse", url: "https://beta.example/sse" },
				},
			],
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "alpha", "plugin.json"), {
			name: "alpha",
			description: "from the package",
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "alpha", "mcp.json"), {
			mcpServers: { alpha: { url: "https://stale.example/mcp" } },
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "gamma", "plugin.json"), {
			name: "gamma",
			version: "1.2.3",
			description: "package description",
			extensions: {
				"musepi.connector": {
					display: {
						name: "Gamma",
						description: "package display",
						examples: ["Do the thing"],
					},
					auth: { mode: "none" },
				},
			},
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "gamma", "mcp.json"), {
			mcpServers: { gamma: { type: "sse", url: "https://gamma.example/sse" } },
		});

		const { entries, warnings } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		expect(entries.map(entry => entry.id)).toEqual(["alpha", "beta", "gamma"]);
		const alpha = entries.find(entry => entry.id === "alpha");
		expect(alpha?.sourceKind).toBe("index");
		expect(alpha?.description).toBe("from the index");
		expect(alpha?.auth.mode).toBe("none");
		expect(entries.find(entry => entry.id === "beta")?.server?.type).toBe("sse");
		const gamma = entries.find(entry => entry.id === "gamma");
		expect(gamma?.sourceKind).toBe("package");
		expect(gamma?.name).toBe("Gamma");
		expect(gamma?.version).toBe("1.2.3");
		expect(gamma?.examples).toEqual(["Do the thing"]);
		expect(warnings.length).toBe(0);
	});

	it("keeps command-only packages as stdio and skips invalid entries with warnings", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "catalog.json"), {
			version: 1,
			connectors: [
				{ id: "Bad Id", name: "invalid", server: { url: "https://x.example/mcp" } },
				{ id: "no-server", name: "invalid", description: "no url" },
			],
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "stdio-only", "plugin.json"), {
			name: "stdio-only",
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "stdio-only", "mcp.json"), {
			mcpServers: { local: { command: "node", args: ["server.js"] } },
		});

		const { entries, warnings } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		expect(entries).toHaveLength(1);
		expect(entries[0]?.id).toBe("stdio-only");
		expect(entries[0]?.server?.type).toBe("stdio");
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("accepts the legacy WorkBuddy extension key", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "marketplace", "legacy", "plugin.json"), {
			name: "legacy",
			extensions: {
				"ai.workbuddy": {
					display: { name: "Legacy", description: "old key", examples_en: ["Try me"] },
					auth: { mode: "none" },
				},
			},
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "legacy", "mcp.json"), {
			mcpServers: { legacy: { url: "https://legacy.example/mcp" } },
		});

		const { entries } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		expect(entries).toHaveLength(1);
		expect(entries[0]?.name).toBe("Legacy");
		expect(entries[0]?.examples).toEqual(["Try me"]);
		expect(entries[0]?.auth.mode).toBe("none");
	});

	it("drops static credential headers from catalog entries", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "catalog.json"), {
			version: 1,
			connectors: [
				{
					id: "alpha",
					name: "Alpha",
					server: {
						type: "http",
						url: "https://alpha.example/mcp",
						headers: { Authorization: "Bearer secret", "X-Trace": "1" },
					},
				},
			],
		});

		const { entries, warnings } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		const server = entries[0]?.server;
		expect(server?.type).toBe("http");
		if (server?.type === "http") expect(server.headers).toEqual({ "X-Trace": "1" });
		expect(warnings.some(warning => warning.includes("static credential header"))).toBe(true);
	});

	it("parses token schemas and rejects token entries without one", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "catalog.json"), {
			version: 1,
			connectors: [
				{
					id: "token-ok",
					name: "Token OK",
					server: { type: "http", url: "https://token.example/mcp" },
					auth: { mode: "token" },
					tokenSchema: {
						title: "Connect",
						fields: [{ key: "API_KEY", label: "API key", type: "password", required: true }],
					},
				},
				{
					id: "token-missing",
					name: "Token missing schema",
					server: { type: "http", url: "https://bad.example/mcp" },
					auth: { mode: "token" },
				},
			],
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "pkg-token", "plugin.json"), {
			name: "pkg-token",
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "pkg-token", "mcp.json"), {
			mcpServers: { pkg: { url: "https://pkg.example/mcp" } },
		});
		await writeJson(
			path.join(agentDir, "connectors", "marketplace", "pkg-token", "ai.workbuddy", "token-schema.json"),
			{
				fields: [{ key: "SITE_KEY", label: "Site key", type: "password", required: true }],
			},
		);

		const { entries, warnings } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		expect(entries.map(entry => entry.id)).toEqual(["pkg-token", "token-ok"]);
		const tokenOk = entries.find(entry => entry.id === "token-ok");
		expect(tokenOk?.auth.mode).toBe("token");
		expect(tokenOk?.tokenSchema?.fields[0]?.required).toBe(true);
		const packaged = entries.find(entry => entry.id === "pkg-token");
		expect(packaged?.auth.mode).toBe("token");
		expect(packaged?.tokenSchema?.fields[0]?.key).toBe("SITE_KEY");
		expect(warnings.some(warning => warning.includes("no token schema"))).toBe(true);
	});
	it("parses stdio entries from the index and package directories", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "catalog.json"), {
			version: 1,
			connectors: [
				{
					id: "stdio-index",
					name: "Stdio Index",
					server: { type: "stdio", command: "node", args: ["server.js"], env: { A: "1" } },
					auth: { mode: "none" },
				},
			],
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "stdio-pkg", "plugin.json"), {
			name: "stdio-pkg",
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "stdio-pkg", "mcp.json"), {
			mcpServers: { pkg: { command: "npx", args: ["-y", "demo-mcp"] } },
		});

		const { entries } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		const index = entries.find(entry => entry.id === "stdio-index");
		expect(index?.server).toEqual({ type: "stdio", command: "node", args: ["server.js"], env: { A: "1" } });
		const packaged = entries.find(entry => entry.id === "stdio-pkg");
		expect(packaged?.server?.type).toBe("stdio");
		if (packaged?.server?.type === "stdio") {
			expect(packaged.server.command).toBe("npx");
			expect(packaged.server.args).toEqual(["-y", "demo-mcp"]);
		}
	});
	it("parses CLI packages and index entries", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "catalog.json"), {
			version: 1,
			connectors: [
				{
					id: "cli-index",
					name: "CLI Index",
					cli: {
						runtime: { type: "node", version: ">=18" },
						init: { win32: "npm install -g demo-cli" },
						versionCheck: { command: { win32: "demo-cli --version" }, minVersion: "1.0.0" },
						auth: { win32: "demo-cli auth login --no-browser" },
						statusMatch: "Logged in",
					},
				},
			],
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "cli-pkg", "plugin.json"), {
			name: "cli-pkg",
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "cli-pkg", "ai.workbuddy", "cli.json"), {
			init: { linux: "npm install -g pkg-cli" },
			auth: { linux: "pkg-cli auth" },
			status: { linux: "pkg-cli status" },
		});

		const { entries } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		const index = entries.find(entry => entry.id === "cli-index");
		expect(index?.cli?.versionCheck?.minVersion).toBe("1.0.0");
		expect(index?.server).toBeUndefined();
		const packaged = entries.find(entry => entry.id === "cli-pkg");
		expect(packaged?.cli?.init?.linux).toBe("npm install -g pkg-cli");
		expect(packaged?.auth.mode).toBe("none");
	});
});
