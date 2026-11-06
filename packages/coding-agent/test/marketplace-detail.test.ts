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
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "marketplace-detail-"));
	tempDirs.push(root);
	return {
		marketplacesRegistryPath: path.join(root, "marketplaces.json"),
		installedRegistryPath: path.join(root, "installed_plugins.json"),
		marketplacesCacheDir: path.join(root, "cache", "marketplaces"),
		pluginsCacheDir: path.join(root, "cache", "plugins"),
		clearPluginRootsCache: () => {},
	};
}

describe("marketplace plugin details", () => {
	it("loads complete metadata once and reuses the persistent clone on later reads", async () => {
		const opts = await options();
		const clonePath = path.join(opts.marketplacesCacheDir, ".tmp-clone-detail");
		await Bun.write(
			path.join(clonePath, "package.json"),
			JSON.stringify({ name: "modern-web-guidance", version: "0.0.197", description: "Modern Web best practices" }),
		);
		await Bun.write(
			path.join(clonePath, ".codex-plugin", "plugin.json"),
			JSON.stringify({
				interface: {
					displayName: "Modern Web Guidance",
					longDescription: "Complete browser compatibility guidance from Google Chrome.",
					logo: "./assets/logo.png",
					capabilities: ["Read"],
				},
			}),
		);
		await Bun.write(path.join(clonePath, "assets", "logo.png"), "logo");
		await Bun.write(
			path.join(clonePath, "skills", "modern-web-guidance", "SKILL.md"),
			"---\nname: modern-web-guidance\ndescription: Search modern Web guidance\n---\nUse the guide.\n",
		);
		await Bun.write(
			path.join(clonePath, "skills", "chrome-extensions", "SKILL.md"),
			"---\nname: chrome-extensions\ndescription: Build Chrome extensions\n---\nUse Manifest V3.\n",
		);
		const catalog = {
			name: "googlechrome",
			owner: { name: "Google Chrome" },
			plugins: [
				{ name: "modern-web-guidance", source: "./", version: "0.0.197", description: "Modern Web best practices" },
			],
		};
		const fetch = vi.spyOn(fetcher, "fetchMarketplace").mockResolvedValue({ catalog, clonePath });
		const manager = new MarketplaceManager({ ...opts, includeDefaultMarketplaces: true });

		const first = await manager.getPluginDetail("modern-web-guidance", "googlechrome");
		expect(first).toMatchObject({
			displayName: "Modern Web Guidance",
			longDescription: "Complete browser compatibility guidance from Google Chrome.",
			capabilities: ["Read"],
			skills: [
				{ name: "chrome-extensions", description: "Build Chrome extensions" },
				{ name: "modern-web-guidance", description: "Search modern Web guidance" },
			],
		});
		expect(first.icon).toStartWith("file://");
		expect(fetch).toHaveBeenCalledOnce();
		expect(await manager.listInstalledPlugins()).toEqual([]);

		fetch.mockClear();
		fetch.mockImplementation(() => {
			throw new Error("network must not be used by the cached read");
		});
		const second = await manager.getPluginDetail("modern-web-guidance", "googlechrome");
		expect(second).toEqual(first);
		expect(fetch).not.toHaveBeenCalled();
	});
});
