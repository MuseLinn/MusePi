/**
 * Track A config hot reload: a config edit remounts the plugin through the same
 * pipeline as its first mount, so the new instance receives the new values and
 * the old one is replaced (dsh's config-edit reload).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	resetPluginConfigStoreCache,
	writePluginConfigValue,
} from "../src/extensibility/extensions-center/plugin-config-store";
import { PluginRuntime } from "../src/extensibility/plugin-runtime/plugin-api";
import { disposePluginPrimitives } from "../src/extensibility/plugins/runtime/cordis-primitives";
import { pluginConfigStoreKey } from "../src/extensibility/plugins/runtime/declared-config";
import { reloadSessionPlugin } from "../src/extensibility/plugins/runtime/session-loader";
import { EventBus } from "../src/utils/event-bus";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

let agentDir: string;
let fixtureDir: string;
let entryPath: string;
let probePath: string;

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("plugin-config-reload-");
	await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
	fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-config-reload-entry-"));
	probePath = path.join(fixtureDir, "probe.json");
	process.env.PLUGIN_CONFIG_PROBE = probePath;
	await Bun.write(
		path.join(fixtureDir, "package.json"),
		JSON.stringify({ name: "config-reload-probe", musepi: { extensions: ["index.ts"], label: "Probe" } }),
	);
	await Bun.write(
		path.join(fixtureDir, "config.json"),
		JSON.stringify({ fields: [{ key: "answer", type: "number", default: 0, restart: "session" }] }),
	);
	await Bun.write(
		path.join(fixtureDir, "index.ts"),
		`export const name = "config-reload-probe";
export const Config = { "~standard": { version: 1, vendor: "test", validate: value => ({ value }) } };
export async function apply(_ctx, config) {
	await Bun.write(process.env.PLUGIN_CONFIG_PROBE, JSON.stringify(config));
}
`,
	);
	entryPath = path.join(fixtureDir, "index.ts");
}, 30000);

afterAll(async () => {
	resetPluginConfigStoreCache();
	await restoreAgentDirForTest(agentDir);
	await fs.rm(fixtureDir, { recursive: true, force: true });
	delete process.env.PLUGIN_CONFIG_PROBE;
}, 30000);

describe("Track A config reload", () => {
	test("a second mount receives the value written after the first", async () => {
		const key = pluginConfigStoreKey(entryPath);
		const runtime = new PluginRuntime();
		const eventBus = new EventBus();

		await writePluginConfigValue(key, "answer", 1);
		resetPluginConfigStoreCache();
		const first = await reloadSessionPlugin({ entryPath, cwd: fixtureDir, runtime, eventBus });
		expect(first.errors).toEqual([]);
		expect(JSON.parse(await Bun.file(probePath).text())).toEqual({ answer: 1 });

		await writePluginConfigValue(key, "answer", 2);
		resetPluginConfigStoreCache();
		const second = await reloadSessionPlugin({ entryPath, cwd: fixtureDir, runtime, eventBus });
		expect(second.errors).toEqual([]);
		expect(second.extension).not.toBe(first.extension);
		expect(JSON.parse(await Bun.file(probePath).text())).toEqual({ answer: 2 });

		if (first.extension) await disposePluginPrimitives(first.extension);
		if (second.extension) await disposePluginPrimitives(second.extension);
	});
});
