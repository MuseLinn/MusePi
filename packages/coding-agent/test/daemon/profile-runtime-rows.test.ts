import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import type { Extension, LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

interface RowTarget {
	path: string;
	rowId: string;
	config: Record<string, unknown>;
	additionalInject?: readonly string[];
}

let root = "";
let projectDir = "";
let agentDir = "";
let host: DaemonHostContext;
let runtime: CordisDynamicPluginRuntime;
let service: ExtensionService;
let settings: Settings;
let targets: RowTarget[] = [];

async function invoke(load: LoadExtensionsResult, commandName: string): Promise<unknown> {
	for (const extension of load.extensions) {
		const command = extension.commands.get(commandName);
		if (command) return command.handler("", {} as never);
	}
	throw new Error(`active command not found: ${commandName}`);
}

function extensionWith(load: LoadExtensionsResult, commandName: string): Extension {
	const extension = load.extensions.find(candidate => candidate.commands.has(commandName));
	if (!extension) throw new Error(`active extension not found: ${commandName}`);
	return extension;
}

async function writeRowPlugin(): Promise<string> {
	const dir = path.join(root, "row-plugin");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "row-plugin", version: "0.0.0", musepi: { extensions: ["./index.ts"] } }),
	);
	await fs.writeFile(
		path.join(dir, "index.ts"),
		`import { sharedValue } from "../shared";
export default {
	Config: {},
	apply(pi: any, config: any) {
		if (config.command === "row-b" && sharedValue() === "shared-v3-fail") {
			throw new Error("row-b replacement apply failed");
		}
		pi.registerCommand(config.command, { handler: async () => config.label + ":" + sharedValue() });
	},
};
`,
	);
	return path.join(dir, "index.ts");
}

async function writeDeclinedPlugin(): Promise<string> {
	const dir = path.join(root, "declined-plugin");
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "declined-plugin", version: "0.0.0", musepi: { extensions: ["./index.ts"] } }),
	);
	const counterKey = `declined-count:${root}`;
	await fs.writeFile(
		path.join(dir, "index.ts"),
		`export default {
	Config: {},
	apply(pi: any, config: any) {
		const key = ${JSON.stringify(counterKey)};
		const count = ((globalThis as any)[key] ?? 0) + 1;
		(globalThis as any)[key] = count;
		pi.registerCommand(config.command, { handler: async () => String(count) });
	},
};
`,
	);
	return path.join(dir, "index.ts");
}

async function writeShared(value: string): Promise<void> {
	await fs.writeFile(
		path.join(root, "shared.ts"),
		`export function sharedValue() { return ${JSON.stringify(value)}; }\n`,
	);
}

beforeEach(async () => {
	agentDir = await isolateAgentDirForTest("profile-runtime-rows-agent-");
	root = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-profile-runtime-rows-"));
	projectDir = path.join(root, "project");
	await fs.mkdir(projectDir, { recursive: true });
	await writeShared("shared-v1");
	host = new DaemonHostContext();
	runtime = new CordisDynamicPluginRuntime(host);
	settings = Settings.isolated();
	service = new ExtensionService({
		settings: () => settings,
		ensureRegistry: async () => ({}),
		cwd: () => projectDir,
		webUrl: () => null,
		webPortFile: () => path.join(projectDir, "web.port"),
		dynamicRuntime: async () => runtime,
		runtimeTargets: async () => targets,
		onChanged: () => {},
	});
});

afterEach(async () => {
	await runtime.dispose();
	await host.dispose();
	delete (globalThis as Record<string, unknown>)[`declined-count:${root}`];
	await fs.rm(root, { recursive: true, force: true });
	await restoreAgentDirForTest(agentDir);
}, 30_000);

describe("ExtensionService composed-row runtime loading", () => {
	test("two rows sharing one entry retain independent records and config", async () => {
		const entry = await writeRowPlugin();
		// Ambient discovery also sees this entry. Its composed rows replace that
		// package-level mount instead of creating a third, unconfigured instance.
		settings.set("extensions", [entry]);
		targets = [
			{ path: entry, rowId: "row-a", config: { command: "row-a", label: "A" } },
			{ path: entry, rowId: "row-b", config: { command: "row-b", label: "B" } },
		];

		const loaded = await service.getExtensionRuntimeLoad();

		expect(loaded.errors).toEqual([]);
		expect(
			loaded.extensions.filter(extension => extension.commands.has("row-a") || extension.commands.has("row-b")),
		).toHaveLength(2);
		expect(await invoke(loaded, "row-a")).toBe("A:shared-v1");
		expect(await invoke(loaded, "row-b")).toBe("B:shared-v1");
		expect(
			runtime
				.inspect()
				.filter(
					record =>
						record.status === "active" &&
						(record.effectLabels.includes("registerCommand:row-a") ||
							record.effectLabels.includes("registerCommand:row-b")),
				),
		).toHaveLength(2);
		expect(
			runtime.inspect().filter(record => record.name === "row-plugin" && record.status === "active"),
		).toHaveLength(2);
	});

	test("a shared source edit reloads both rows but not a declined row", async () => {
		const entry = await writeRowPlugin();
		const declinedEntry = await writeDeclinedPlugin();
		targets = [
			{ path: entry, rowId: "row-a", config: { command: "row-a", label: "A" } },
			{ path: entry, rowId: "row-b", config: { command: "row-b", label: "B" } },
			{ path: declinedEntry, rowId: "row-c", config: { command: "row-c" } },
		];
		const initial = await service.getExtensionRuntimeLoad();
		const declined = extensionWith(initial, "row-c");
		expect(await invoke(initial, "row-c")).toBe("1");

		await writeShared("shared-v2");
		service.invalidateExtensionsCache();
		const reloaded = await service.getExtensionRuntimeLoad();

		expect(reloaded.errors).toEqual([]);
		expect(await invoke(reloaded, "row-a")).toBe("A:shared-v2");
		expect(await invoke(reloaded, "row-b")).toBe("B:shared-v2");
		expect(extensionWith(reloaded, "row-c")).toBe(declined);
		expect(await invoke(reloaded, "row-c")).toBe("1");
	});

	test("one row's apply failure restores both previous row instances", async () => {
		const entry = await writeRowPlugin();
		targets = [
			{ path: entry, rowId: "row-a", config: { command: "row-a", label: "A" } },
			{ path: entry, rowId: "row-b", config: { command: "row-b", label: "B" } },
		];
		const initial = await service.getExtensionRuntimeLoad();
		const oldRowA = extensionWith(initial, "row-a").commands.get("row-a")!.handler as (
			args: string,
			ctx: never,
		) => Promise<unknown>;
		const oldRowB = extensionWith(initial, "row-b").commands.get("row-b")!.handler as (
			args: string,
			ctx: never,
		) => Promise<unknown>;
		expect(await invoke(initial, "row-a")).toBe("A:shared-v1");
		expect(await invoke(initial, "row-b")).toBe("B:shared-v1");

		await writeShared("shared-v3-fail");
		service.invalidateExtensionsCache();
		const failed = await service.getExtensionRuntimeLoad();

		expect(failed.errors.some(error => error.error.includes("row-b replacement apply failed"))).toBe(true);
		expect(await oldRowA("", {} as never)).toBe("A:shared-v1");
		expect(await oldRowB("", {} as never)).toBe("B:shared-v1");
		expect(await invoke(failed, "row-a")).toBe("A:shared-v1");
		expect(await invoke(failed, "row-b")).toBe("B:shared-v1");
		expect(
			runtime
				.inspect()
				.filter(
					record =>
						record.status === "active" &&
						(record.effectLabels.includes("registerCommand:row-a") ||
							record.effectLabels.includes("registerCommand:row-b")),
				),
		).toHaveLength(2);
	});
});
