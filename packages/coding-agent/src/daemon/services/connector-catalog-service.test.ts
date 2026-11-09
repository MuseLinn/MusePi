import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../../../test/helpers/isolate-agent-dir";
import { readConnectorSecrets } from "../../connectors/secrets";
import { ConnectorCatalogService } from "./connector-catalog-service";

let isolatedDir = "";

beforeAll(async () => {
	isolatedDir = await isolateAgentDirForTest("musepi-connector-service-");
	const connectorsDir = path.join(getAgentDir(), "connectors");
	await fs.mkdir(connectorsDir, { recursive: true });
	const cliScript = path.join(getAgentDir(), "fake-cli.mjs");
	const cliState = path.join(getAgentDir(), "cli-logged-in");
	await fs.writeFile(
		cliScript,
		`import fs from "node:fs";
const [cmd, state] = process.argv.slice(2);
if (cmd === "--version") console.log("1.2.3");
else if (cmd === "auth") {
  fs.writeFileSync(state, "1");
  console.log("Open https://example.com/device");
  console.log("code: ABCD-1234");
  setTimeout(() => {}, 30000);
} else if (cmd === "status") {
  console.log(fs.existsSync(state) ? "Logged in" : "Not logged in");
} else if (cmd === "logout") {
  try { fs.unlinkSync(state); } catch {}
}
`,
		"utf8",
	);
	const cliRun = (args: string): string => `"${process.execPath}" "${cliScript}" ${args}`;
	const cliCommands = (args: string) => ({
		darwin: cliRun(args),
		linux: cliRun(args),
		win32: cliRun(args),
	});
	await fs.writeFile(
		path.join(connectorsDir, "catalog.json"),
		JSON.stringify({
			version: 1,
			connectors: [
				{
					id: "alpha",
					name: "Alpha",
					description: "remote",
					server: { type: "http", url: "https://alpha.example/mcp" },
					auth: { mode: "oauth" },
				},
				{
					id: "beta",
					name: "Beta",
					description: "open",
					server: { type: "http", url: "https://beta.example/mcp" },
					auth: { mode: "none" },
				},
				{
					id: "delta",
					name: "Delta",
					description: "stdio",
					server: { type: "stdio", command: "node", args: ["server.js"] },
					auth: { mode: "none" },
				},
				{
					id: "echo-cli",
					name: "Echo CLI",
					description: "managed cli",
					cli: {
						versionCheck: { command: cliCommands(`--version "${cliState}"`), minVersion: "1.0.0" },
						auth: cliCommands(`auth "${cliState}"`),
						status: cliCommands(`status "${cliState}"`),
						unAuth: cliCommands(`logout "${cliState}"`),
						statusMatch: "Logged in",
					},
				},
				{
					id: "gamma",
					name: "Gamma",
					description: "token",
					server: { type: "http", url: "https://gamma.example/mcp" },
					auth: { mode: "token" },
					tokenSchema: {
						fields: [{ key: "API_KEY", label: "API key", type: "password", required: true }],
					},
				},
			],
		}),
		"utf8",
	);
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedDir);
}, 30_000);

describe("ConnectorCatalogService", () => {
	it("lists catalog rows, enables one, and reports live manager status", async () => {
		let reloads = 0;
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({
				servers: [{ name: "connector:alpha", transport: "http", status: "connected" }],
			}),
			reloadConnectors: async () => {
				reloads += 1;
			},
		});

		const initial = await service.list();
		expect(initial.connectors.map(row => row.id)).toEqual(["alpha", "beta", "delta", "echo-cli", "gamma"]);
		expect(initial.connectors[0]).toMatchObject({ enabled: false, status: "disconnected", authMode: "oauth" });

		const connected = await service.connect({ id: "alpha" });
		expect(connected).toMatchObject({
			ok: true,
			id: "alpha",
			serverName: "connector:alpha",
			needsAuth: true,
			status: "connected",
		});
		expect(reloads).toBe(1);

		const after = await service.list({ query: "alph" });
		expect(after.connectors).toHaveLength(1);
		expect(after.connectors[0]).toMatchObject({ id: "alpha", enabled: true, status: "connected" });

		const disconnected = await service.setEnabled({ id: "alpha", enabled: false });
		expect(disconnected).toEqual({ ok: true, id: "alpha", enabled: false });
		expect(reloads).toBe(2);
	});

	it("requires a token before connecting and deletes it on disconnect", async () => {
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
		});

		const blocked = await service.connect({ id: "gamma" });
		expect(blocked).toMatchObject({ ok: false, needsTokenConfig: true, id: "gamma" });
		expect(await readConnectorSecrets("gamma")).toBeUndefined();

		await expect(service.saveToken({ id: "gamma", values: { NOPE: "x" } })).rejects.toThrow("unknown token field");
		await expect(service.saveToken({ id: "gamma", values: { API_KEY: "" } })).rejects.toThrow(
			"missing required token fields",
		);

		await service.saveToken({ id: "gamma", values: { API_KEY: "secret" } });
		expect(await readConnectorSecrets("gamma")).toEqual({ API_KEY: "secret" });
		expect((await service.list()).connectors.find(row => row.id === "gamma")?.tokenSet).toBe(true);

		const connected = await service.connect({ id: "gamma" });
		expect(connected).toMatchObject({ ok: true, needsAuth: false });
		expect(connected.needsTokenConfig).toBeUndefined();

		await service.disconnect({ id: "gamma" });
		expect(await readConnectorSecrets("gamma")).toBeUndefined();
	});

	it("requires explicit command approval before enabling a stdio connector", async () => {
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
		});

		const blocked = await service.connect({ id: "delta" });
		expect(blocked).toMatchObject({
			ok: false,
			needsApproval: true,
			command: "node",
			args: ["server.js"],
		});

		const approved = await service.connect({ id: "delta", approve: true });
		expect(approved).toMatchObject({ ok: true, id: "delta" });
		expect((await service.list()).connectors.find(row => row.id === "delta")).toMatchObject({
			enabled: true,
			server: { transport: "stdio", command: "node" },
		});

		await service.disconnect({ id: "delta" });
		const again = await service.connect({ id: "delta" });
		expect(again).toMatchObject({ ok: false, needsApproval: true });
	});

	it("runs a CLI connector through approval, auth, status, and logout", async () => {
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
		});

		const blocked = await service.connect({ id: "echo-cli" });
		expect(blocked).toMatchObject({ ok: false, needsApproval: true });
		expect(blocked.authCommand).toContain("fake-cli.mjs");

		const started = await service.connect({ id: "echo-cli", approve: true });
		expect(started).toMatchObject({ ok: false, needsCliAuth: true });
		expect(started.authorizationUrl).toBe("https://example.com/device");
		expect(started.userCode).toBe("ABCD-1234");
		expect(started.flowId).toBeString();

		const pending = await service.cliStatus({ flowId: started.flowId });
		expect(pending).toMatchObject({ status: "success", connectorId: "echo-cli" });
		const row = (await service.list()).connectors.find(candidate => candidate.id === "echo-cli");
		expect(row).toMatchObject({ kind: "cli", cliAuth: true, enabled: true });

		await service.disconnect({ id: "echo-cli" });
		expect((await service.list()).connectors.find(candidate => candidate.id === "echo-cli")?.enabled).toBe(false);
		await expect(fs.access(path.join(getAgentDir(), "cli-logged-in"))).rejects.toThrow();
	});

	it("rejects unknown ids and malformed toggles", async () => {
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
		});

		await expect(service.connect({ id: "missing" })).rejects.toThrow("unknown connector");
		await expect(service.detail({ id: "missing" })).rejects.toThrow("unknown connector");
		await expect(service.setEnabled({ id: "alpha", enabled: "yes" })).rejects.toThrow("enabled must be a boolean");
		await expect(service.connect({ id: "../escape" })).rejects.toThrow("invalid connector id");
	});
});
