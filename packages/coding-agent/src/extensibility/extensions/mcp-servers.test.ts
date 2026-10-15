import { describe, expect, it } from "bun:test";
import { type ExtensionMcpHost, ExtensionMcpRegistry } from "./mcp-servers";

/**
 * Extension-owned MCP servers against a fake host: no processes, no network.
 * The fake mirrors `MCPManager` semantics the registry relies on (connect
 * records configs, status reflects connections, disconnect drops them).
 */
function fakeHost(): ExtensionMcpHost & {
	connected: Map<string, unknown>;
	disconnected: string[];
	connectCalls: number;
	failNext: string | null;
} {
	const connected = new Map<string, unknown>();
	const disconnected: string[] = [];
	const state = {
		connected,
		disconnected,
		connectCalls: 0,
		failNext: null as string | null,
		async connectServers(configs: Record<string, Record<string, unknown>>) {
			this.connectCalls++;
			const errors = new Map<string, string>();
			const connectedServers: string[] = [];
			for (const [name, config] of Object.entries(configs)) {
				if (this.failNext === name) {
					this.failNext = null;
					errors.set(name, "spawn ENOENT");
					continue;
				}
				connected.set(name, config);
				connectedServers.push(name);
			}
			return { tools: [], errors, connectedServers, exaApiKeys: [] };
		},
		async disconnectServer(name: string): Promise<void> {
			disconnected.push(name);
			connected.delete(name);
		},
		getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
			return connected.has(name) ? "connected" : "disconnected";
		},
	};
	return state as unknown as ExtensionMcpHost & typeof state;
}

const CONFIG = { command: "node", args: ["server.mjs"] } as unknown as Parameters<ExtensionMcpRegistry["register"]>[1];

describe("ExtensionMcpRegistry", () => {
	it("registers, reports ownership, and unregisters", async () => {
		const host = fakeHost();
		const registry = new ExtensionMcpRegistry(() => host);

		await expect(registry.register("docs", CONFIG)).resolves.toEqual({ name: "docs" });
		expect(registry.owned()).toEqual(["docs"]);
		expect(host.connectCalls).toBe(1);

		await expect(registry.unregister("docs")).resolves.toBe(true);
		expect(registry.owned()).toEqual([]);
		expect(host.disconnected).toEqual(["docs"]);
		await expect(registry.unregister("docs")).resolves.toBe(false);
	});

	it("rejects bad names and configs without touching the host", async () => {
		const host = fakeHost();
		const registry = new ExtensionMcpRegistry(() => host);

		await expect(registry.register("", CONFIG)).rejects.toThrow(/non-empty/);
		await expect(registry.register("  ", CONFIG)).rejects.toThrow(/non-empty/);
		await expect(
			registry.register("x", null as unknown as Parameters<ExtensionMcpRegistry["register"]>[1]),
		).rejects.toThrow(/must be an object/);
		// command+url together is incoherent per the manager's own validator.
		await expect(registry.register("x", { command: "a", url: "https://b" } as never)).rejects.toThrow(
			/invalid config/,
		);
		expect(host.connectCalls).toBe(0);
		expect(registry.owned()).toEqual([]);
	});

	it("re-registering the identical config is a no-op", async () => {
		const host = fakeHost();
		const registry = new ExtensionMcpRegistry(() => host);

		await registry.register("docs", CONFIG);
		await expect(registry.register("docs", { ...CONFIG })).resolves.toEqual({ name: "docs" });
		expect(host.connectCalls).toBe(1);
	});

	it("refuses to hijack a differently-configured live server", async () => {
		const host = fakeHost();
		const registry = new ExtensionMcpRegistry(() => host);
		// Foreign connection the registry never recorded.
		host.connected.set("docs", { command: "other" });

		await expect(registry.register("docs", CONFIG)).rejects.toThrow(/different config/);
		expect(registry.owned()).toEqual([]);
	});

	it("surfaces connection failures without recording ownership", async () => {
		const host = fakeHost();
		host.failNext = "docs";
		const registry = new ExtensionMcpRegistry(() => host);

		await expect(registry.register("docs", CONFIG)).rejects.toThrow(/ENOENT/);
		expect(registry.owned()).toEqual([]);
	});

	it("requires an MCP host", async () => {
		const registry = new ExtensionMcpRegistry(() => undefined);
		await expect(registry.register("docs", CONFIG)).rejects.toThrow(/not available/);
		// Unregister/release without a host still clear local ownership.
		await expect(registry.unregister("docs")).resolves.toBe(false);
		await expect(registry.releaseAll()).resolves.toEqual([]);
	});

	it("releaseAll disconnects everything best-effort", async () => {
		const host = fakeHost();
		const registry = new ExtensionMcpRegistry(() => host);
		await registry.register("a", CONFIG);
		await registry.register("b", CONFIG);

		await expect(registry.releaseAll()).resolves.toEqual(["a", "b"]);
		expect(registry.owned()).toEqual([]);
		expect(host.disconnected).toEqual(["a", "b"]);
		expect(host.connected.size).toBe(0);
	});
});
