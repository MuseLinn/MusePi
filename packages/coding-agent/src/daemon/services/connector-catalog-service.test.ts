import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../../../test/helpers/isolate-agent-dir";
import { readConnectorSecrets } from "../../connectors/secrets";
import { mcpOAuthCredentialId } from "../../mcp/oauth-flow";
import type { AuthStorage } from "../../session/auth-storage";
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
			authStorage: async () => null,
		});

		const initial = await service.list();
		// The fixture's ids, matched as a subset: the bundled layer ships rows too.
		expect(initial.connectors.map(row => row.id)).toEqual(
			expect.arrayContaining(["alpha", "beta", "delta", "echo-cli", "gamma"]),
		);
		expect(initial.connectors.find(row => row.id === "alpha")).toMatchObject({
			enabled: false,
			status: "disconnected",
			authMode: "oauth",
		});

		const pending = await service.connect({ id: "alpha" });
		expect(pending).toMatchObject({
			ok: true,
			id: "alpha",
			serverName: "connector:alpha",
			needsAuth: true,
			status: "disconnected",
		});
		// Nothing is enabled before the sign-in lands: a failed flow must leave
		// the row where it started.
		expect(reloads).toBe(0);
		expect((await service.list({ query: "alph" })).connectors[0]).toMatchObject({ enabled: false });

		// An open row enables immediately and reports the live manager status.
		const connected = await service.connect({ id: "beta" });
		expect(connected).toMatchObject({ ok: true, id: "beta", needsAuth: false });
		expect(reloads).toBe(1);

		const after = await service.list({ query: "beta" });
		expect(after.connectors).toHaveLength(1);
		expect(after.connectors[0]).toMatchObject({ id: "beta", enabled: true });

		const disconnected = await service.setEnabled({ id: "beta", enabled: false });
		expect(disconnected).toEqual({ ok: true, id: "beta", enabled: false });
		expect(reloads).toBe(2);
	});

	it("enables an OAuth row whose grant is already stored", async () => {
		let reloads = 0;
		const grantUrl = "https://alpha.example/mcp";
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => {
				reloads += 1;
			},
			authStorage: async () =>
				({
					get: (id: string) => (id === mcpOAuthCredentialId(grantUrl) ? { type: "oauth" } : undefined),
				}) as unknown as AuthStorage,
		});

		const result = await service.connect({ id: "alpha" });
		expect(result).toMatchObject({ ok: true, id: "alpha", needsAuth: false });
		expect(reloads).toBe(1);
	});

	it("asks for a browser sign-in unless a pasted token answers the row", async () => {
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
			authStorage: async () => null,
		});

		// A plain OAuth row still needs a sign-in.
		const plain = await service.connect({ id: "alpha" });
		expect(plain).toMatchObject({ ok: true, id: "alpha", needsAuth: true });

		// The GitHub row carries a pasted-token fallback, so it also needs a
		// sign-in until that token is filled.
		const withTokenForm = await service.connect({ id: "github" });
		expect(withTokenForm).toMatchObject({ ok: true, id: "github", needsAuth: true });
	});

	it("requires a token before connecting and deletes it on disconnect", async () => {
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
			authStorage: async () => null,
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
			authStorage: async () => null,
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
			authStorage: async () => null,
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
			authStorage: async () => null,
		});

		await expect(service.connect({ id: "missing" })).rejects.toThrow("unknown connector");
		await expect(service.detail({ id: "missing" })).rejects.toThrow("unknown connector");
		await expect(service.setEnabled({ id: "alpha", enabled: "yes" })).rejects.toThrow("enabled must be a boolean");
		await expect(service.connect({ id: "../escape" })).rejects.toThrow("invalid connector id");
	});

	it("remounts an enabled connector when read-only is switched on", async () => {
		let reloads = 0;
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => {
				reloads += 1;
			},
			authStorage: async () => null,
		});

		await service.connect({ id: "beta" });
		expect(reloads).toBe(1);
		expect((await service.detail({ id: "beta" })).connector.readOnly).toBe(false);

		await service.setReadOnly({ id: "beta", readOnly: true });
		expect(reloads).toBe(2);
		expect((await service.detail({ id: "beta" })).connector).toMatchObject({ enabled: true, readOnly: true });

		await service.setReadOnly({ id: "beta", readOnly: false });
		expect(reloads).toBe(3);
		expect((await service.detail({ id: "beta" })).connector.readOnly).toBe(false);
	});

	it("records the switch for a disabled row without reloading", async () => {
		let reloads = 0;
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => {
				reloads += 1;
			},
			authStorage: async () => null,
		});

		// Nothing is mounted, so the switch only has to be remembered.
		await service.connect({ id: "beta" });
		await service.disconnect({ id: "beta" });
		const before = reloads;
		await service.setReadOnly({ id: "beta", readOnly: true });
		expect(reloads).toBe(before);

		await service.connect({ id: "beta" });
		expect((await service.detail({ id: "beta" })).connector).toMatchObject({ enabled: true, readOnly: true });
	});

	it("refuses a read-only toggle for an unknown connector or a non-boolean", async () => {
		const service = new ConnectorCatalogService({
			cwd: () => "/workspace",
			connectorsSnapshotForCwd: async () => ({ servers: [] }),
			reloadConnectors: async () => undefined,
			authStorage: async () => null,
		});

		await expect(service.setReadOnly({ id: "missing", readOnly: true })).rejects.toThrow("unknown connector");
		await expect(service.setReadOnly({ id: "beta", readOnly: "yes" })).rejects.toThrow("readOnly must be a boolean");
	});
});
