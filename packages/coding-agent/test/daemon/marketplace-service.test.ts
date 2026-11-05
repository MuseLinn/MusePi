/**
 * marketplace 更新/源管理 RPC 契约测试（能力中心市场 tab）。
 *
 * 契约：
 * 1. marketplace.list 的 installedVersion/updateAvailable 与
 *    marketplace.updates 判定一致：project 作用域覆盖 user；semver 更低的
 *    catalog 版本不算更新（不是「版本不同」就报可升级）。
 * 2. marketplace.install 的 expectedVersion 在写盘前拒绝 catalog 漂移，
 *    与用户在确认框里看到的版本一致才安装。
 * 3. marketplace.upgrade 单个/全部按 catalog 版本重装，并回报 from/to；
 *    双作用域未指定 scope 时拒绝而不是静默挑一个。
 * 4. marketplace.sources.add/remove 落盘到 marketplaces.json（新 manager
 *    重读可见），重名拒绝，移除同时删目录缓存；refresh 按源收集失败。
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@musepi/pi-utils";
import { MarketplaceService } from "../../src/daemon/services/marketplace-service";
import { MarketplaceManager } from "../../src/extensibility/plugins/marketplace";

const MANAGED_ROOTS: string[] = [];

afterEach(() => {
	for (const root of MANAGED_ROOTS.splice(0)) removeSyncWithRetries(root);
});

interface Harness {
	root: string;
	fixtureRoot: string;
	marketplacesRegistryPath: string;
	installedRegistryPath: string;
	projectInstalledRegistryPath: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;
	manager: MarketplaceManager;
	service: MarketplaceService;
	/** Fresh manager over the same files: proves registry writes are persisted. */
	reread(): Promise<string[]>;
}

function writeMarketplaceSource(dir: string, name: string, pluginVersion: string): string {
	const root = path.join(dir, name);
	const pluginDir = path.join(root, "plugins", "hello-plugin");
	fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name,
			owner: { name: "Test" },
			plugins: [{ name: "hello-plugin", source: "./plugins/hello-plugin", version: pluginVersion }],
		}),
	);
	fs.writeFileSync(
		path.join(pluginDir, "package.json"),
		JSON.stringify({ name: "hello-plugin", version: pluginVersion }),
	);
	fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {};\n");
	return root;
}

function seedInstalled(registryPath: string, scope: "user" | "project", version: string): void {
	fs.mkdirSync(path.dirname(registryPath), { recursive: true });
	fs.writeFileSync(
		registryPath,
		JSON.stringify({
			version: 2,
			plugins: {
				"hello-plugin@test-marketplace": [
					{
						scope,
						installPath: path.join(path.dirname(registryPath), "stale-install"),
						version,
						installedAt: "2026-01-01T00:00:00Z",
						lastUpdated: "2026-01-01T00:00:00Z",
					},
				],
			},
		}),
	);
}

function setup(): Harness {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-marketplace-svc-"));
	MANAGED_ROOTS.push(root);

	const fixtureRoot = path.join(root, "fixtures");
	fs.mkdirSync(fixtureRoot, { recursive: true });

	const marketplacesRegistryPath = path.join(root, "marketplaces.json");
	const installedRegistryPath = path.join(root, "installed_plugins.json");
	const projectInstalledRegistryPath = path.join(root, "project", "installed_plugins.json");
	const marketplacesCacheDir = path.join(root, "cache", "marketplaces");
	const pluginsCacheDir = path.join(root, "cache", "plugins");

	const makeManager = (): MarketplaceManager =>
		new MarketplaceManager({
			marketplacesRegistryPath,
			installedRegistryPath,
			projectInstalledRegistryPath,
			marketplacesCacheDir,
			pluginsCacheDir,
			clearPluginRootsCache: () => {},
			compatibilityExemptionsPath: path.join(root, "compatibility.json"),
		});

	const manager = makeManager();
	const service = new MarketplaceService({
		cwd: () => path.join(root, "project"),
		settings: () => null,
		extensionEntries: async () => [],
		invalidateExtensionsCache: () => {},
		invalidatePluginCaches: () => {},
		onChanged: () => {},
		onInstallState: () => {},
		buildManager: async () => manager,
	});

	return {
		root,
		fixtureRoot,
		marketplacesRegistryPath,
		installedRegistryPath,
		projectInstalledRegistryPath,
		marketplacesCacheDir,
		pluginsCacheDir,
		manager,
		service,
		reread: async () => (await makeManager().listMarketplaces()).map(m => m.name),
	};
}

describe("marketplace updates", () => {
	test("list 与 updates 对同一安装给出相同的 from/to，且 project 覆盖 user", async () => {
		const h = setup();
		const fixture = writeMarketplaceSource(h.fixtureRoot, "test-marketplace", "2.0.0");
		await h.service.addSource({ source: fixture });

		seedInstalled(h.installedRegistryPath, "user", "1.0.0");
		const userList = await h.service.list();
		expect(userList.entries).toHaveLength(1);
		expect(userList.entries[0]).toMatchObject({
			name: "hello-plugin",
			version: "2.0.0",
			installed: true,
			installedScope: "user",
			installedVersion: "1.0.0",
			updateAvailable: true,
		});
		expect((await h.service.updates()).updates).toEqual([
			{ pluginId: "hello-plugin@test-marketplace", scope: "user", from: "1.0.0", to: "2.0.0" },
		]);

		// Project install is current: it shadows the stale user copy, so the
		// card and the update planner must both report "up to date". Installing
		// through the service also busts the list cache, which is how the GUI
		// observes the new state.
		await h.service.install({
			name: "hello-plugin",
			marketplace: "test-marketplace",
			scope: "project",
			expectedVersion: "2.0.0",
		});
		const projectList = await h.service.list();
		expect(projectList.entries[0]).toMatchObject({
			installedScope: "project",
			installedVersion: "2.0.0",
			updateAvailable: false,
		});
		// checkForUpdates is per-scope by design (a stale scope stays
		// upgradeable even when another scope shadows it), so the shadowed
		// user install remains listed here while the card reflects the
		// active project install.
		expect((await h.service.updates()).updates).toEqual([
			{ pluginId: "hello-plugin@test-marketplace", scope: "user", from: "1.0.0", to: "2.0.0" },
		]);
	});

	test("catalog 版本更低时不算可更新（semver 序，而非版本不同）", async () => {
		const h = setup();
		const fixture = writeMarketplaceSource(h.fixtureRoot, "test-marketplace", "1.9.0");
		await h.service.addSource({ source: fixture });
		seedInstalled(h.installedRegistryPath, "user", "2.0.0");

		const { entries } = await h.service.list();
		expect(entries[0]).toMatchObject({ installedVersion: "2.0.0", updateAvailable: false });
		expect((await h.service.updates()).updates).toEqual([]);
	});

	test("非 semver tag 变化仍视为可更新", async () => {
		const h = setup();
		const fixture = writeMarketplaceSource(h.fixtureRoot, "test-marketplace", "build-42");
		await h.service.addSource({ source: fixture });
		seedInstalled(h.installedRegistryPath, "user", "build-41");

		expect((await h.service.list()).entries[0]).toMatchObject({ updateAvailable: true });
		expect((await h.service.updates()).updates[0]).toMatchObject({ from: "build-41", to: "build-42" });
	});
});

describe("marketplace install trust gate", () => {
	test("expectedVersion 与 catalog 不一致时拒绝且不写 registry", async () => {
		const h = setup();
		const fixture = writeMarketplaceSource(h.fixtureRoot, "test-marketplace", "2.0.0");
		await h.service.addSource({ source: fixture });

		await expect(
			h.service.install({
				name: "hello-plugin",
				marketplace: "test-marketplace",
				expectedVersion: "1.0.0",
			}),
		).rejects.toThrow(/changed since it was reviewed: expected version 1\.0\.0, catalog now has 2\.0\.0/);
		expect(fs.existsSync(h.installedRegistryPath)).toBe(false);

		const result = await h.service.install({
			name: "hello-plugin",
			marketplace: "test-marketplace",
			expectedVersion: "2.0.0",
		});
		expect(result).toMatchObject({ ok: true, installed: true, scope: "user" });
		const installed = await h.manager.listInstalledPlugins();
		expect(installed[0]?.entries[0]?.version).toBe("2.0.0");
	});
});

describe("marketplace upgrade", () => {
	test("upgrade all 升级过期安装并清空 updates", async () => {
		const h = setup();
		const fixture = writeMarketplaceSource(h.fixtureRoot, "test-marketplace", "2.0.0");
		await h.service.addSource({ source: fixture });
		seedInstalled(h.installedRegistryPath, "user", "1.0.0");

		const result = await h.service.upgrade({ all: true });
		expect(result.upgraded).toEqual([
			{ pluginId: "hello-plugin@test-marketplace", scope: "user", from: "1.0.0", to: "2.0.0" },
		]);
		expect((await h.service.updates()).updates).toEqual([]);
		const { entries } = await h.service.list();
		expect(entries[0]).toMatchObject({ installedVersion: "2.0.0", updateAvailable: false });
	});

	test("双作用域未指定 scope 时拒绝，而不是静默挑一个", async () => {
		const h = setup();
		seedInstalled(h.installedRegistryPath, "user", "1.0.0");
		seedInstalled(h.projectInstalledRegistryPath, "project", "1.0.0");

		await expect(h.service.upgrade({ pluginId: "hello-plugin@test-marketplace" })).rejects.toThrow(
			/both user and project scope/,
		);
		await expect(h.service.upgrade({ all: false })).rejects.toThrow(/pluginId required/);
	});
});

describe("marketplace sources", () => {
	test("add 落盘、重名拒绝、remove 清 registry 与目录缓存", async () => {
		const h = setup();
		const fixture = writeMarketplaceSource(h.fixtureRoot, "test-marketplace", "1.0.0");

		const added = await h.service.addSource({ source: fixture });
		expect(added.source).toMatchObject({ name: "test-marketplace", sourceType: "local" });
		expect(await h.reread()).toEqual(["test-marketplace"]);
		expect(fs.existsSync(path.join(h.marketplacesCacheDir, "test-marketplace", "marketplace.json"))).toBe(true);

		await expect(h.service.addSource({ source: fixture })).rejects.toThrow(/already exists/);

		await h.service.removeSource({ name: "test-marketplace" });
		expect((await h.service.listSources()).sources).toEqual([]);
		expect(await h.reread()).toEqual([]);
		expect(fs.existsSync(path.join(h.marketplacesCacheDir, "test-marketplace"))).toBe(false);
	});

	test("refresh 全部时单源失败不阻断其余源", async () => {
		const h = setup();
		const alpha = writeMarketplaceSource(h.fixtureRoot, "alpha-marketplace", "1.0.0");
		const beta = writeMarketplaceSource(h.fixtureRoot, "beta-marketplace", "1.0.0");
		await h.service.addSource({ source: alpha });
		await h.service.addSource({ source: beta });

		// The beta source disappears after registration: its catalog cache is
		// still readable, but re-fetching must fail and be reported per source.
		fs.rmSync(beta, { recursive: true, force: true });

		const all = await h.service.refreshSources({});
		expect(all.sources.map(s => s.name)).toEqual(["alpha-marketplace"]);
		expect(all.failures).toHaveLength(1);
		expect(all.failures[0]).toContain("beta-marketplace");
		expect(all.ok).toBe(false);

		const one = await h.service.refreshSources({ name: "alpha-marketplace" });
		expect(one).toMatchObject({ ok: true, failures: [] });
		expect(one.sources.map(s => s.name)).toEqual(["alpha-marketplace"]);
	});
});
