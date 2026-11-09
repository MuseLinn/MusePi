import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../../test/helpers/isolate-agent-dir";
import { loadCapability } from "../capability";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { setConnectorEnabled } from "../connectors/state";
import "./connector-catalog";

let isolatedDir = "";
let cwd = "";

beforeAll(async () => {
	isolatedDir = await isolateAgentDirForTest("musepi-connector-discovery-");
	cwd = await fs.mkdtemp(path.join(tmpdir(), "musepi-connector-cwd-"));
	const connectorsDir = path.join(getAgentDir(), "connectors");
	await fs.mkdir(connectorsDir, { recursive: true });
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
					description: "disabled",
					server: { type: "http", url: "https://beta.example/mcp" },
				},
			],
		}),
		"utf8",
	);
	await setConnectorEnabled("alpha", true);
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedDir);
}, 30_000);

describe("connector catalog discovery provider", () => {
	it("mounts only enabled connectors under the connector namespace", async () => {
		const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: ["connector-catalog"] });
		const alpha = result.items.find(item => item.name === "connector:alpha");
		expect(alpha).toMatchObject({
			name: "connector:alpha",
			url: "https://alpha.example/mcp",
			transport: "http",
			auth: { type: "oauth" },
			enabled: true,
		});
		expect(alpha?._source.provider).toBe("connector-catalog");
		expect(result.items.some(item => item.name === "connector:beta")).toBe(false);
	});
});
