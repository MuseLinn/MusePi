/**
 * Track A config identity: the management write and every runtime reader share
 * one key — the package name (`pluginEntryId`). The failure this locks down:
 * the form wrote `<name>` while the bundled / session / host readers looked up
 * `extension-module:<name>`, so a configured plugin silently ran on defaults.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getExtensionNameFromPath } from "../src/discovery/helpers";
import {
	resetPluginConfigStoreCache,
	writePluginConfigValue,
} from "../src/extensibility/extensions-center/plugin-config-store";
import { pluginConfigStoreKey, readDeclaredPluginConfig } from "../src/extensibility/plugins/runtime/declared-config";
import { defaultSessionConfigReader } from "../src/extensibility/plugins/runtime/session-loader";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const ENTRY = path.resolve(import.meta.dir, "../src/plugins/workspace/compaction-tiers/index.ts");

describe("Track A plugin config identity", () => {
	let agentDir: string;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("plugin-config-identity-");
		await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
	}, 30000);

	afterAll(async () => {
		resetPluginConfigStoreCache();
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	test("the key is the package name, not a kind-prefixed row id", () => {
		expect(pluginConfigStoreKey(ENTRY)).toBe(getExtensionNameFromPath(ENTRY));
		expect(pluginConfigStoreKey(ENTRY)).toBe("compaction-tiers");
	});

	test("the management form's write reaches the bundled and session readers", async () => {
		await writePluginConfigValue(pluginConfigStoreKey(ENTRY), "capPercent", 55);
		resetPluginConfigStoreCache();

		// The bundled loader and `ctx.config` read through this function.
		expect((await readDeclaredPluginConfig(ENTRY)).values.capPercent).toBe(55);
		// The session / host loader's default reader is the same read.
		const reader = await defaultSessionConfigReader();
		expect((await reader(ENTRY)).values.capPercent).toBe(55);
	});
});
