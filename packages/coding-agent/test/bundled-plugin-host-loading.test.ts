/**
 * Host-scope packages mount once per process, with no session: that is what
 * makes a provider visible to session-less RPC (`memory.status`) and to the
 * first session alike.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureHostHalfPluginsLoaded, resetHostHalfPluginsLoaded } from "../src/bundled-plugins/loader";
import { discoverBundledPluginPaths } from "../src/discovery/builtin";
import {
	getPluginConfigPath,
	resetPluginConfigStoreCache,
	writePluginConfigValue,
} from "../src/extensibility/extensions-center/plugin-config-store";
import type { HmrService } from "../src/extensibility/plugins/hmr/service";
import { reloadHostPlugins } from "../src/extensibility/plugins/runtime/host-runtime";
import { getHostService } from "../src/extensibility/plugins/runtime/host-services";
import { findMemoryBackendProvider } from "../src/memory-backend/providers";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

let agentDir: string;

beforeAll(async () => {
	agentDir = await isolateAgentDirForTest("host-plugin-loading-");
});

afterEach(async () => {
	await resetHostHalfPluginsLoaded();
});

afterAll(async () => {
	resetPluginConfigStoreCache();
	await restoreAgentDirForTest(agentDir);
}, 30_000);

describe("host-scope bundled plugins", () => {
	it("mounts without a session and registers the backend provider", async () => {
		await resetHostHalfPluginsLoaded();
		expect(findMemoryBackendProvider("sharpshooter")).toBeUndefined();

		expect(await ensureHostHalfPluginsLoaded(process.cwd())).toBe(true);
		expect(findMemoryBackendProvider("sharpshooter")).toMatchObject({ id: "sharpshooter" });

		// One mount per process: a second pass is a no-op.
		expect(await ensureHostHalfPluginsLoaded(process.cwd())).toBe(false);
	});

	it("delegates the HMR provider's own change to the host as restart-required", async () => {
		await resetHostHalfPluginsLoaded();
		await ensureHostHalfPluginsLoaded(process.cwd());
		const service = getHostService<HmrService>("hmr");
		expect(service).toBeDefined();
		const hmrEntry = (await discoverBundledPluginPaths({ scope: "host" })).find(
			entry => path.basename(path.dirname(entry)) === "hmr",
		);
		expect(hmrEntry).toBeDefined();

		await reloadHostPlugins([hmrEntry!]);

		expect(service!.restartRequired).toMatchObject({ entry: hmrEntry });
	});

	it("delegates a host-module change to the host as restart-required", async () => {
		await resetHostHalfPluginsLoaded();
		await ensureHostHalfPluginsLoaded(process.cwd());
		const hostModule = path.join(process.cwd(), "src", "extensibility", "extensions", "loader.ts");

		await reloadHostPlugins([hostModule]);

		expect(getHostService<HmrService>("hmr")?.restartRequired).toMatchObject({ file: hostModule });
	});

	it("ignores a config notification whose effective values did not change", async () => {
		await resetHostHalfPluginsLoaded();
		await ensureHostHalfPluginsLoaded(process.cwd());
		const service = getHostService<HmrService>("hmr");
		expect(service?.restartRequired).toBeNull();

		const reloaded = await reloadHostPlugins([getPluginConfigPath()]);

		expect(reloaded).toEqual([]);
		expect(service?.restartRequired).toBeNull();
	});

	it("keeps restart-required when HMR's own config changes", async () => {
		const storePath = getPluginConfigPath();
		const previous = await Bun.file(storePath)
			.text()
			.catch(() => null);
		try {
			await resetHostHalfPluginsLoaded();
			await ensureHostHalfPluginsLoaded(process.cwd());
			const service = getHostService<HmrService>("hmr");
			expect(service?.restartRequired).toBeNull();
			await writePluginConfigValue("extension-module:hmr", "debounce", 321);

			await reloadHostPlugins([storePath]);

			expect(service?.restartRequired).toMatchObject({
				reason: "it provides the HMR service that delivers this batch",
			});
		} finally {
			if (previous === null) await fs.rm(storePath, { force: true });
			else await Bun.write(storePath, previous);
			resetPluginConfigStoreCache();
		}
	});

	it("removes the registration when the host loader resets", async () => {
		await resetHostHalfPluginsLoaded();
		await ensureHostHalfPluginsLoaded(process.cwd());
		expect(findMemoryBackendProvider("sharpshooter")).toBeDefined();

		await resetHostHalfPluginsLoaded();
		expect(findMemoryBackendProvider("sharpshooter")).toBeUndefined();
	});
});
