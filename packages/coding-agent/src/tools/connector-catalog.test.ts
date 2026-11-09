import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../../test/helpers/isolate-agent-dir";
import { ConnectorCatalogTool } from "./connector-catalog";

let isolatedDir = "";
let tool: ConnectorCatalogTool;

beforeAll(async () => {
	isolatedDir = await isolateAgentDirForTest("musepi-connector-tool-");
	const connectorsDir = path.join(getAgentDir(), "connectors");
	await fs.mkdir(connectorsDir, { recursive: true });
	await fs.writeFile(
		path.join(connectorsDir, "catalog.json"),
		JSON.stringify({
			version: 1,
			connectors: [
				{
					id: "alpha",
					name: "Alpha Meetings",
					description: "Schedule meetings",
					category: "productivity",
					server: {
						type: "http",
						url: "https://alpha.example/mcp",
						headers: { Authorization: "Bearer should-not-leak" },
					},
					auth: { mode: "oauth" },
				},
				{
					id: "beta",
					name: "Beta Docs",
					description: "Search documents",
					server: { type: "http", url: "https://beta.example/mcp" },
					auth: { mode: "none" },
				},
			],
		}),
		"utf8",
	);
	tool = new ConnectorCatalogTool();
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedDir);
}, 30_000);

describe("connector_catalog tool", () => {
	it("lists and searches real catalog rows", async () => {
		const list = await tool.execute("call-1", { action: "list" });
		const text = list.content[0]?.type === "text" ? list.content[0].text : "";
		expect(text).toContain("alpha — Alpha Meetings");
		expect(text).toContain("beta — Beta Docs");
		expect(text).toContain("not enabled");
		expect(list.details).toMatchObject({ action: "list", count: 2 });

		const search = await tool.execute("call-2", { action: "search", query: "meeting" });
		const searchText = search.content[0]?.type === "text" ? search.content[0].text : "";
		expect(searchText).toContain("alpha");
		expect(searchText).not.toContain("beta");
	});

	it("returns details without static headers or credentials", async () => {
		const detail = await tool.execute("call-3", { action: "detail", id: "alpha" });
		const text = detail.content[0]?.type === "text" ? detail.content[0].text : "";
		expect(text).toContain("Alpha Meetings (alpha)");
		expect(text).toContain("auth: oauth");
		expect(text).not.toContain("should-not-leak");
		expect(text).not.toContain("headers");
	});

	it("rejects missing or unknown ids", async () => {
		await expect(tool.execute("call-4", { action: "detail" })).rejects.toThrow("detail requires id");
		await expect(tool.execute("call-5", { action: "detail", id: "missing" })).rejects.toThrow("unknown connector");
		await expect(tool.execute("call-6", { action: "search" })).rejects.toThrow("search requires query");
	});
});
