import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { getTerminalProvider } from "../../src/daemon/terminal-provider";
import { TerminalRegistry } from "../../src/daemon/terminal-registry";
import { createBundledPluginRuntime } from "../helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const pendingHandle = {
	write: () => {},
	resize: () => {},
	dispose: () => {},
	onData: () => {},
	onExit: () => {},
};

describe("terminal provider components through extensions RPC", () => {
	let agentDir: string;
	let settings: Settings;
	let service: ExtensionService;
	let bundled: ReturnType<typeof createBundledPluginRuntime>;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("terminal-backend-component-");
		settings = Settings.isolated();
		bundled = createBundledPluginRuntime();
		service = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => process.cwd(),
			webUrl: () => null,
			webPortFile: () => "",
			dynamicRuntime: async () => bundled.runtime,
			onChanged: () => {},
		});
	}, 30_000);

	afterAll(async () => {
		await bundled.dispose();
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("disables exactly one provider through its canonical component key", async () => {
		await service.setComponentEnabled({ id: "terminal", component: "bun-pty", enabled: false });
		expect(settings.get("disabledExtensionComponents")).toEqual(["terminal/bun-pty"]);
		expect(settings.get("tools.disabled")).toEqual([]);
		expect(bundled.terminalRegistry.hasBackend("bun-pty")).toBe(false);
		expect(bundled.terminalRegistry.hasBackend("node-pty")).toBe(true);
	}, 30_000);

	it("lists only the disabled provider as disabled", async () => {
		const terminal = (await service.list()).extensions.find(entry => entry.id === "terminal");
		const byId = new Map(terminal?.components?.map(component => [component.id, component]));
		expect(byId.get("bun-pty")?.enabled).toBe(false);
		expect(byId.get("node-pty")?.enabled).toBe(true);
	});

	it("re-enabling remounts only that provider", async () => {
		await service.setComponentEnabled({ id: "terminal", component: "bun-pty", enabled: true });
		expect(settings.get("disabledExtensionComponents")).toEqual([]);
		expect(bundled.terminalRegistry.hasBackend("bun-pty")).toBe(true);
	}, 30_000);

	it("rejects old package IDs and undeclared providers without writes", async () => {
		await expect(
			service.setComponentEnabled({ id: "terminal:terminal", component: "bun-pty", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		await expect(service.setComponentEnabled({ id: "terminal", component: "auto", enabled: false })).rejects.toThrow(
			/auto/,
		);
		expect(settings.get("disabledExtensionComponents")).toEqual([]);
	});
});

describe("terminal provider registry selection", () => {
	it("falls back to a registered backend and reports explicit missing backends", async () => {
		const registry = new TerminalRegistry();
		let calls = 0;
		registry.registerBackend("node-pty", {
			open: () => {
				calls++;
				return Promise.resolve(pendingHandle as never);
			},
		});
		await getTerminalProvider("auto", registry).open(".", 80, 24, "sh", [], {});
		expect(calls).toBe(1);
		const error = await getTerminalProvider("bun-pty", registry)
			.open(".", 80, 24, "sh", [], {})
			.catch(reason => reason);
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain("terminal backend not registered: bun-pty");
	});
});
