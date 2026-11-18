import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { clearConnectorCatalogCache, loadConnectorCatalog } from "./catalog";

async function tempAgentDir(): Promise<string> {
	return fs.mkdtemp(path.join(tmpdir(), "musepi-connector-catalog-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

/** Ids the fixture itself declared, so a test reads the same as the bundled layer grows. */
function fixtureIds(entries: Array<{ id: string; sourceKind: string }>): string[] {
	return entries.filter(entry => entry.sourceKind !== "bundled").map(entry => entry.id);
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

		expect(fixtureIds(entries)).toEqual(["alpha", "beta", "gamma"]);
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

		expect(fixtureIds(entries)).toEqual(["stdio-only"]);
		expect(entries.find(entry => entry.id === "stdio-only")?.server?.type).toBe("stdio");
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

		const legacy = entries.find(entry => entry.id === "legacy");
		expect(legacy?.name).toBe("Legacy");
		expect(legacy?.examples).toEqual(["Try me"]);
		expect(legacy?.auth.mode).toBe("none");
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

		const server = entries.find(entry => entry.id === "alpha")?.server;
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

		expect(fixtureIds(entries)).toEqual(["pkg-token", "token-ok"]);
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

	it("ships a bundled catalog an empty profile can list", async () => {
		const agentDir = await tempAgentDir();

		const { entries, warnings } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		const bundled = entries.filter(entry => entry.sourceKind === "bundled");
		expect(bundled.length).toBeGreaterThan(0);
		expect(warnings).toEqual([]);
		for (const entry of bundled) {
			expect(entry.server?.type).toBe("http");
			expect(entry.description.length).toBeGreaterThan(0);
			if (entry.auth.mode === "token") expect(entry.tokenSchema).toBeDefined();
		}
		expect(bundled.filter(entry => entry.featured === true).length).toBeGreaterThan(0);
	});

	it("lets a user index and a package both replace a bundled entry", async () => {
		const agentDir = await tempAgentDir();
		await writeJson(path.join(agentDir, "connectors", "catalog.json"), {
			version: 1,
			connectors: [
				{
					id: "github",
					name: "GitHub (pinned)",
					server: { type: "http", url: "https://pinned.example/mcp" },
					auth: { mode: "none" },
				},
			],
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "notion", "plugin.json"), {
			name: "notion",
			extensions: { "musepi.connector": { auth: { mode: "none" } } },
		});
		await writeJson(path.join(agentDir, "connectors", "marketplace", "notion", "mcp.json"), {
			mcpServers: { notion: { url: "https://packaged.example/mcp" } },
		});

		const { entries } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		const github = entries.find(entry => entry.id === "github");
		expect(github?.sourceKind).toBe("index");
		expect(github?.name).toBe("GitHub (pinned)");
		const notion = entries.find(entry => entry.id === "notion");
		expect(notion?.sourceKind).toBe("package");
		if (notion?.server?.type === "http") expect(notion.server.url).toBe("https://packaged.example/mcp");
	});

	it("carries display language and a query-carried token through the bundled layer", async () => {
		const agentDir = await tempAgentDir();

		const { entries } = await loadConnectorCatalog({ agentDir, env: {}, refresh: true });

		const amap = entries.find(entry => entry.id === "amap");
		expect(amap?.auth.mode).toBe("token");
		expect(amap?.tokenSchema?.query).toBe("key");
		expect(amap?.tokenSchema?.header).toBeUndefined();
		expect(amap?.descriptionZh?.length).toBeGreaterThan(0);
	});

	describe("remote index cache", () => {
		const index = {
			version: 1,
			connectors: [
				{
					id: "remote-one",
					name: "Remote one",
					description: "from the index",
					server: { type: "http", url: "https://remote.example/mcp" },
					auth: { mode: "none" },
				},
			],
		};

		/** A server that counts hits and can be told to fail. */
		async function serveIndex(body: unknown): Promise<{
			url: string;
			hits(): number;
			fail(next: boolean): void;
			etag: string;
			stop(): void;
		}> {
			let hits = 0;
			let failing = false;
			const etag = '"v1"';
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					hits += 1;
					if (failing) return new Response("down", { status: 500 });
					if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
					return Response.json(body, { headers: { etag } });
				},
			});
			return {
				url: `http://127.0.0.1:${server.port}/catalog.json`,
				hits: () => hits,
				fail: next => {
					failing = next;
				},
				etag,
				stop: () => server.stop(true),
			};
		}

		/** The cache file for a URL, written the way the loader writes it. */
		async function ageCache(agentDir: string, url: string): Promise<void> {
			const dir = path.join(agentDir, "connectors", "index-cache");
			const file = path.join(dir, `${Bun.hash(url).toString(36)}.json`);
			const cached = JSON.parse(await fs.readFile(file, "utf8")) as { fetchedAt: number };
			cached.fetchedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
			await fs.writeFile(file, JSON.stringify(cached), "utf8");
		}

		it("serves a fresh cached index without asking again", async () => {
			const agentDir = await tempAgentDir();
			const remote = await serveIndex(index);
			try {
				const first = await loadConnectorCatalog({
					agentDir,
					env: { MUSEPI_CONNECTOR_CATALOG: remote.url },
					refresh: true,
				});
				expect(first.entries.some(entry => entry.id === "remote-one")).toBe(true);
				expect(remote.hits()).toBe(1);

				// A later load reads the copy on disk: the process cache is
				// cleared, the disk cache is not.
				clearConnectorCatalogCache();
				const second = await loadConnectorCatalog({ agentDir, env: { MUSEPI_CONNECTOR_CATALOG: remote.url } });
				expect(second.entries.some(entry => entry.id === "remote-one")).toBe(true);
				expect(remote.hits()).toBe(1);
			} finally {
				remote.stop();
			}
		});

		it("falls back to an expired cache when the index cannot be reached", async () => {
			const agentDir = await tempAgentDir();
			const remote = await serveIndex(index);
			try {
				await loadConnectorCatalog({ agentDir, env: { MUSEPI_CONNECTOR_CATALOG: remote.url }, refresh: true });
				await ageCache(agentDir, remote.url);
				remote.fail(true);

				clearConnectorCatalogCache();
				const result = await loadConnectorCatalog({ agentDir, env: { MUSEPI_CONNECTOR_CATALOG: remote.url } });

				expect(result.entries.some(entry => entry.id === "remote-one")).toBe(true);
				expect(result.warnings.some(warning => /HTTP 500/.test(warning))).toBe(true);
				expect(result.warnings.some(warning => /cached/.test(warning))).toBe(true);
			} finally {
				remote.stop();
			}
		});

		it("does not reach the network unless a remote index is configured", async () => {
			const agentDir = await tempAgentDir();
			const remote = await serveIndex(index);
			try {
				for (const env of [{}, { MUSEPI_CONNECTOR_CATALOG: "off" }]) {
					const result = await loadConnectorCatalog({ agentDir, env, refresh: true });
					expect(result.entries.some(entry => entry.id === "remote-one")).toBe(false);
				}
				expect(remote.hits()).toBe(0);
			} finally {
				remote.stop();
			}
		});
	});
});
