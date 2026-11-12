/**
 * A preset row's MCP server is registered by the plugin that declared it, on
 * the session that joined that preset, and released with the same runner.
 *
 * dsh gives a preset row the same plugin context as any other plugin; MCP
 * registration is session-scoped there too (`ctx.registerMcpServer` inside a
 * session). This pins the MusePi path end to end: bundled row plugin → preset
 * scope dispatch → session context → connection, then release on shutdown.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ExtensionRuntime } from "@musepi/pi-coding-agent/extensibility/extensions/loader";
import type { ExtensionMcpHost } from "@musepi/pi-coding-agent/extensibility/extensions/mcp-servers";
import { ExtensionRunner, emitSessionStartEvent } from "@musepi/pi-coding-agent/extensibility/extensions/runner";
import { mountPlugin } from "@musepi/pi-coding-agent/extensibility/plugins/runtime/mount";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { TempDir } from "@musepi/pi-utils";
import { EventBus } from "../src/utils/event-bus";

const PLUGIN_ENTRY = path.resolve(import.meta.dir, "../src/bundled-plugins/mcp-client/index.ts");

function fixtureHost(): { host: ExtensionMcpHost; connected: string[]; disconnected: string[] } {
	const connected: string[] = [];
	const disconnected: string[] = [];
	const status = new Map<string, "connected" | "connecting" | "disconnected">();
	const host: ExtensionMcpHost = {
		async connectServers(configs) {
			for (const name of Object.keys(configs)) {
				connected.push(name);
				status.set(name, "connected");
			}
			return {
				tools: [],
				errors: new Map<string, string>(),
				connectedServers: Object.keys(configs),
				exaApiKeys: [],
			};
		},
		async disconnectServer(name) {
			disconnected.push(name);
			status.set(name, "disconnected");
		},
		getConnectionStatus(name) {
			return status.get(name) ?? "disconnected";
		},
	};
	return { host, connected, disconnected };
}

describe("preset MCP client row", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@preset-mcp-");
	});

	async function mountWith(values: Record<string, unknown>, host: ExtensionMcpHost, key: object) {
		const runtime = new ExtensionRuntime();
		const mounted = await mountPlugin({
			entryPath: PLUGIN_ENTRY,
			cwd: tempDir.path(),
			eventBus: new EventBus(),
			runtime,
			readConfig: async () => ({ fields: [], values }),
			scopeTag: key,
		});
		if (!mounted.ok) throw new Error(mounted.message);
		const runner = new ExtensionRunner(
			[mounted.extension],
			runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			null as never,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined, // getAgentId
			() => host, // getMcpHost
		);
		runner.setPresetScopeKey(key);
		return runner;
	}

	it("connects the row's server on session start and releases it on shutdown", async () => {
		const { host, connected, disconnected } = fixtureHost();
		const runner = await mountWith(
			{ serverName: "demo", command: "node", args: '["server.js"]', timeout: 45000 },
			host,
			{},
		);

		await emitSessionStartEvent(runner);
		expect(connected).toEqual(["demo"]);

		await runner.releaseMcpServers();
		expect(disconnected).toEqual(["demo"]);
	});

	it("leaves a row without a server name inert", async () => {
		const { host, connected } = fixtureHost();
		const runner = await mountWith({ serverName: "" }, host, {});
		await emitSessionStartEvent(runner);
		expect(connected).toEqual([]);
	});
});
