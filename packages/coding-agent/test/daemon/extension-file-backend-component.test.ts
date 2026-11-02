import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { resetCapabilityActivations } from "../../src/extensibility/capability-activation";
import { fileBackendForTool, isFileBackendToolAllowed, isFileIndexBackendEnabled } from "../../src/tools/file-backend";
import { createBundledPluginRuntime } from "../helpers/bundled-plugin-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

describe("file capability components through extensions RPC", () => {
	let agentDir: string;
	let settings: Settings;
	let service: ExtensionService;
	let bundled: ReturnType<typeof createBundledPluginRuntime>;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("file-backend-component-");
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

	it("disables the write family through its component fiber", async () => {
		await service.setComponentEnabled({ id: "file-tools", component: "write", enabled: false });
		expect(settings.get("disabledExtensionComponents")).toEqual(["file-tools/write"]);
		expect(settings.get("tools.disabled")).toEqual([]);
		expect(isFileBackendToolAllowed("edit")).toBe(false);
		expect(isFileBackendToolAllowed("read")).toBe(true);
	}, 30_000);

	it("lists only write as disabled", async () => {
		const file = (await service.list()).extensions.find(entry => entry.id === "file-tools");
		const byId = new Map(file?.components?.map(component => [component.id, component]));
		expect(byId.get("write")?.enabled).toBe(false);
		expect(byId.get("read")?.enabled).toBe(true);
		expect(byId.get("search")?.enabled).toBe(true);
		expect(byId.get("index")?.enabled).toBe(true);
	});

	it("re-enabling write restores the edit family", async () => {
		await service.setComponentEnabled({ id: "file-tools", component: "write", enabled: true });
		expect(settings.get("disabledExtensionComponents")).toEqual([]);
		expect(isFileBackendToolAllowed("edit")).toBe(true);
	}, 30_000);

	it("rejects old IDs and undeclared components without writes", async () => {
		await expect(
			service.setComponentEnabled({ id: "file:file", component: "write", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		await expect(
			service.setComponentEnabled({ id: "file-tools", component: "rename", enabled: false }),
		).rejects.toThrow(/rename/);
		expect(settings.get("disabledExtensionComponents")).toEqual([]);
	});
});

describe("file backend tool mapping", () => {
	it("maps every tool to its owning family", () => {
		expect(fileBackendForTool("read")).toBe("read");
		expect(fileBackendForTool("write")).toBe("write");
		expect(fileBackendForTool("edit")).toBe("write");
		expect(fileBackendForTool("ast_edit")).toBe("write");
		expect(fileBackendForTool("glob")).toBe("search");
		expect(fileBackendForTool("grep")).toBe("search");
		expect(fileBackendForTool("ast_grep")).toBe("search");
		expect(fileBackendForTool("bash")).toBeNull();
	});

	it("keeps index independent from the other families", async () => {
		const host = new DaemonHostContext();
		const runtime = new CordisDynamicPluginRuntime(host);
		try {
			await runtime.load(path.resolve(import.meta.dir, "../../src/bundled-plugins/file-tools"), process.cwd());
			await runtime.setComponentEnabled("file-tools", "index", false);
			expect(isFileIndexBackendEnabled()).toBe(false);
			expect(isFileBackendToolAllowed("read")).toBe(true);
		} finally {
			await runtime.dispose();
			await host.dispose();
			resetCapabilityActivations();
		}
	});
});
