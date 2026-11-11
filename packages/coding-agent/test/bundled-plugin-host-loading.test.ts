/**
 * Host-scope packages mount once per process, with no session: that is what
 * makes a provider visible to session-less RPC (`memory.status`) and to the
 * first session alike.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ensureHostHalfPluginsLoaded, resetHostHalfPluginsLoaded } from "../src/bundled-plugins/loader";
import { discoverBundledPluginPaths } from "../src/discovery/builtin";
import type { HmrService } from "../src/extensibility/plugins/hmr/service";
import { reloadHostPlugins } from "../src/extensibility/plugins/runtime/host-runtime";
import { getHostService } from "../src/extensibility/plugins/runtime/host-services";
import { findMemoryBackendProvider } from "../src/memory-backend/providers";

afterEach(async () => {
	await resetHostHalfPluginsLoaded();
});

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

	it("removes the registration when the host loader resets", async () => {
		await resetHostHalfPluginsLoaded();
		await ensureHostHalfPluginsLoaded(process.cwd());
		expect(findMemoryBackendProvider("sharpshooter")).toBeDefined();

		await resetHostHalfPluginsLoaded();
		expect(findMemoryBackendProvider("sharpshooter")).toBeUndefined();
	});
});
