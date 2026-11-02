import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { resolveBrowserKind } from "../../src/tools/browser";
import { createBundledPluginRuntime } from "../helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

function sessionWith(settings: Settings): Parameters<typeof resolveBrowserKind>[1] {
	return { settings, cwd: process.cwd() } as Parameters<typeof resolveBrowserKind>[1];
}

describe("browser backend components through extensions RPC", () => {
	let agentDir: string;
	let settings: Settings;
	let service: ExtensionService;
	let bundled: ReturnType<typeof createBundledPluginRuntime>;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("browser-backend-component-");
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

	it("disables launch through its fiber and component key", async () => {
		await service.setComponentEnabled({ id: "browser", component: "launch", enabled: false });
		expect(settings.get("disabledExtensionComponents")).toEqual(["browser/launch"]);
		expect(() => resolveBrowserKind({ action: "open" }, sessionWith(settings))).toThrow(
			"no browser backend available",
		);
	}, 30_000);

	it("lists launch as disabled and the other backends as enabled", async () => {
		const browser = (await service.list()).extensions.find(entry => entry.id === "browser");
		const byId = new Map(browser?.components?.map(component => [component.id, component]));
		expect(byId.get("launch")?.enabled).toBe(false);
		expect(byId.get("attach")?.enabled).toBe(true);
		expect(byId.get("gui")?.enabled).toBe(true);
	});

	it("re-enabling launch restores default resolution", async () => {
		await service.setComponentEnabled({ id: "browser", component: "launch", enabled: true });
		expect(settings.get("disabledExtensionComponents")).toEqual([]);
		expect(resolveBrowserKind({ action: "open" }, sessionWith(settings)).kind).toBe("headless");
	}, 30_000);

	it("rejects old IDs and undeclared components without writes", async () => {
		await expect(
			service.setComponentEnabled({ id: "browser:browser", component: "launch", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		await expect(
			service.setComponentEnabled({ id: "browser", component: "browser", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		expect(settings.get("disabledExtensionComponents")).toEqual([]);
	});
});

describe("browser resolution follows active backends", () => {
	it("uses configured attach and GUI backends while their components are active", () => {
		const settings = Settings.isolated();
		settings.set("browser.cdpUrl", "http://127.0.0.1:9222");
		expect(resolveBrowserKind({ action: "open" }, sessionWith(settings)).kind).toBe("connected");
		settings.set("browser.cdpUrl", "");
		settings.set("browser.gui", true);
		settings.set("browser.guiUrl", "http://127.0.0.1:9230");
		expect(resolveBrowserKind({ action: "open" }, sessionWith(settings))).toEqual({
			kind: "connected",
			cdpUrl: "http://127.0.0.1:9230",
			gui: true,
		});
	});
});
