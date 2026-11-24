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
		// The bundled catalog ships rows too, so the count is a floor here.
		const details = list.details as { action?: string; count?: number };
		expect(details.action).toBe("list");
		expect(details.count).toBeGreaterThanOrEqual(2);

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

	it("asks the host for a card and enables only after the user agrees", async () => {
		const asked: Array<{ id: string; purpose: string }> = [];
		let enabled = false;
		const ctx = {
			ui: {
				requestConnector: async (ask: { id: string; name: string; purpose: string; authMode: string }) => {
					asked.push({ id: ask.id, purpose: ask.purpose });
					return "connect" as const;
				},
			},
			connectorRequests: {
				connect: async (id: string) => {
					enabled = id === "beta";
					return { ok: true, status: "connected" as const };
				},
			},
		};

		const result = await tool.execute(
			"call-7",
			{ action: "request", id: "beta", purpose: "read the spec" },
			undefined,
			undefined,
			ctx as never,
		);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(asked).toEqual([{ id: "beta", purpose: "read the spec" }]);
		expect(enabled).toBe(true);
		expect(text).toContain("is connected");
		expect((result.details as { request?: { status?: string } }).request?.status).toBe("connected");
	});

	it("leaves the connector alone when the user declines", async () => {
		let connectCalls = 0;
		const ctx = {
			ui: { requestConnector: async () => "decline" as const },
			connectorRequests: {
				connect: async () => {
					connectCalls += 1;
					return { ok: true, status: "connected" as const };
				},
			},
		};

		const result = await tool.execute(
			"call-8",
			{ action: "request", id: "beta", purpose: "x" },
			undefined,
			undefined,
			ctx as never,
		);
		expect(connectCalls).toBe(0);
		expect((result.details as { request?: { status?: string } }).request?.status).toBe("declined");
	});

	it("reports a row that needs the user instead of claiming success", async () => {
		const ctx = {
			ui: { requestConnector: async () => "connect" as const },
			connectorRequests: {
				connect: async () => ({ ok: true, needsAuth: true, status: "disconnected" as const }),
			},
		};

		const result = await tool.execute(
			"call-9",
			{ action: "request", id: "alpha", purpose: "x" },
			undefined,
			undefined,
			ctx as never,
		);
		const details = result.details as { request?: { status?: string; reason?: string } };
		expect(details.request?.status).toBe("needs-user");
		expect(details.request?.reason).toContain("sign-in");
	});

	it("refuses a request when the host has no card surface", async () => {
		await expect(
			tool.execute("call-10", { action: "request", id: "beta", purpose: "x" }, undefined, undefined, {} as never),
		).rejects.toThrow("cannot show a connection card");
		await expect(tool.execute("call-11", { action: "request", id: "beta" })).rejects.toThrow(
			"request requires purpose",
		);
	});
});
