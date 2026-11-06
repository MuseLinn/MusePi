import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as fetcher from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/fetcher";
import {
	MarketplaceManager,
	type MarketplaceManagerOptions,
} from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/manager";

const tempDirs: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function options(): Promise<MarketplaceManagerOptions> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "default-marketplaces-"));
	tempDirs.push(root);
	return {
		marketplacesRegistryPath: path.join(root, "marketplaces.json"),
		installedRegistryPath: path.join(root, "installed_plugins.json"),
		marketplacesCacheDir: path.join(root, "cache", "marketplaces"),
		pluginsCacheDir: path.join(root, "cache", "plugins"),
		clearPluginRootsCache: () => {},
	};
}

describe("default curated marketplaces", () => {
	it("lists both reviewed plugins without fetching or installing them", async () => {
		const manager = new MarketplaceManager({ ...(await options()), includeDefaultMarketplaces: true });
		expect((await manager.listMarketplaces()).map(entry => entry.name)).toEqual(["superpowers-dev", "googlechrome"]);
		const available = await manager.listAvailablePlugins();
		expect(available.map(entry => entry.name)).toEqual(["superpowers", "modern-web-guidance"]);
		expect(available.map(entry => entry.icon)).toEqual([
			"https://raw.githubusercontent.com/obra/superpowers/v7.0.2/assets/app-icon.png",
			"https://raw.githubusercontent.com/GoogleChrome/modern-web-guidance/v0.0.197/assets/logo.png",
		]);
	});

	it("keeps custom registries default-free unless explicitly enabled", async () => {
		const manager = new MarketplaceManager(await options());
		expect(await manager.listMarketplaces()).toEqual([]);
	});

	it("preserves custom marketplaces and lets them override same-name defaults", async () => {
		const opts = await options();
		await Bun.write(
			opts.marketplacesRegistryPath,
			JSON.stringify({
				version: 1,
				marketplaces: [
					{
						name: "superpowers-dev",
						sourceType: "local",
						sourceUri: "D:/custom/superpowers",
						catalogPath: "D:/custom/superpowers/marketplace.json",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
					{
						name: "team-tools",
						sourceType: "local",
						sourceUri: "D:/custom/team-tools",
						catalogPath: "D:/custom/team-tools/marketplace.json",
						addedAt: "2026-01-01T00:00:00.000Z",
						updatedAt: "2026-01-01T00:00:00.000Z",
					},
				],
			}),
		);
		const manager = new MarketplaceManager({ ...opts, includeDefaultMarketplaces: true });

		const marketplaces = await manager.listMarketplaces();
		expect(marketplaces.map(entry => entry.name)).toEqual(["superpowers-dev", "googlechrome", "team-tools"]);
		expect(marketplaces[0]?.sourceUri).toBe("D:/custom/superpowers");
	});

	it("rejects duplicate add and removal of curated defaults", async () => {
		const manager = new MarketplaceManager({ ...(await options()), includeDefaultMarketplaces: true });
		await expect(manager.addMarketplace("obra/superpowers")).rejects.toThrow("already exists");
		await expect(manager.removeMarketplace("superpowers-dev")).rejects.toThrow("not found");
	});

	it("fetches a curated marketplace on demand before the first install", async () => {
		const opts = await options();
		const clonePath = path.join(opts.marketplacesCacheDir, ".tmp-clone-test");
		await Bun.write(
			path.join(clonePath, "package.json"),
			JSON.stringify({ name: "modern-web-guidance", version: "0.0.197" }),
		);
		await Bun.write(
			path.join(clonePath, "skills", "modern-web-guidance", "SKILL.md"),
			"---\nname: modern-web-guidance\ndescription: Modern web best practices\n---\nUse modern web guidance.\n",
		);
		const fetch = vi.spyOn(fetcher, "fetchMarketplace").mockResolvedValue({
			catalog: {
				name: "googlechrome",
				owner: { name: "Google Chrome" },
				plugins: [{ name: "modern-web-guidance", source: "./", version: "0.0.197" }],
			},
			clonePath,
		});
		const manager = new MarketplaceManager({ ...opts, includeDefaultMarketplaces: true });

		const installed = await manager.installPlugin("modern-web-guidance", "googlechrome", {
			expectedVersion: "0.0.197",
		});

		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledWith("GoogleChrome/modern-web-guidance", opts.marketplacesCacheDir);
		expect(installed.version).toBe("0.0.197");
		expect(await Bun.file(path.join(installed.installPath, "cordis", "index.ts")).exists()).toBe(true);
	});
});
