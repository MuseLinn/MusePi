/**
 * 版本选择升级的契约（manager 层）：
 *
 * 1. 可选版本来自插件仓库的 tag：详情页拿到的列表新版本在前，且始终包含
 *    catalog 版本与已装版本（没有 tag 的仓库因此只有一项）。
 * 2. 安装/升级接受目标版本，安装的是该 tag 的真实内容，登记版本即目标版本。
 * 3. 已装版本更新时显式拒绝降级 —— 不再是「catalog 说啥就装啥」。
 * 4. Git 源更新必须同仓同目录；catalog 换仓/换目录是「重新安装」，
 *    未确认时拒绝，确认后照常安装。
 * 5. 安装失败恢复旧版本：旧缓存目录在新版落定前保留，失败时登记表与
 *    运行时链接都回到旧版本。
 *
 * 仓库 fixture 是真实的本地 git 仓库（离线），tag 解析、克隆、版本判定都走
 * 生产路径；唯一被替换的是 `git ls-remote` 之外的网络访问，这里没有。
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { removeSyncWithRetries } from "@musepi/pi-utils";

import { MarketplaceManager } from "./manager";
import { buildPluginId } from "./types";

// Every case builds a real Git repository and the install path spawns Git
// several times; on Windows that regularly exceeds Bun's 5s default.
setDefaultTimeout(30_000);

const MANAGED_ROOTS: string[] = [];
const PLUGIN_ID = "hello-plugin@test-marketplace";

afterEach(() => {
	for (const root of MANAGED_ROOTS.splice(0)) removeSyncWithRetries(root);
});

interface Harness {
	root: string;
	marketplaceRoot: string;
	installedRegistryPath: string;
	pluginsCacheDir: string;
	manager: MarketplaceManager;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
	]);
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
	return stdout;
}

/** Write (or rewrite) the marketplace catalog + plugin at `version`. */
function writePluginSource(root: string, version: string): void {
	const pluginDir = path.join(root, "plugins", "hello-plugin");
	fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name: "test-marketplace",
			owner: { name: "Test" },
			plugins: [{ name: "hello-plugin", source: "./plugins/hello-plugin", version }],
		}),
	);
	fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "hello-plugin", version }));
	fs.writeFileSync(path.join(pluginDir, "index.ts"), `export const version = ${JSON.stringify(version)};\n`);
}

/** Commit the current tree and (optionally) tag it. */
async function commitVersion(root: string, version: string, tag?: string): Promise<void> {
	writePluginSource(root, version);
	await runGit(root, ["add", "-A"]);
	await runGit(root, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", version]);
	if (tag !== undefined) await runGit(root, ["tag", tag]);
}

async function setup(): Promise<Harness> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-plugin-versions-"));
	MANAGED_ROOTS.push(root);

	const marketplaceRoot = path.join(root, "marketplace");
	fs.mkdirSync(marketplaceRoot, { recursive: true });
	await runGit(marketplaceRoot, ["init", "-q"]);
	// Three published versions; HEAD is the newest one, exactly like a real repo.
	await commitVersion(marketplaceRoot, "1.0.0", "v1.0.0");
	await commitVersion(marketplaceRoot, "1.5.0", "v1.5.0");
	await commitVersion(marketplaceRoot, "2.0.0", "v2.0.0");

	const manager = new MarketplaceManager({
		marketplacesRegistryPath: path.join(root, "marketplaces.json"),
		installedRegistryPath: path.join(root, "installed_plugins.json"),
		projectInstalledRegistryPath: path.join(root, "project", "installed_plugins.json"),
		marketplacesCacheDir: path.join(root, "cache", "marketplaces"),
		pluginsCacheDir: path.join(root, "cache", "plugins"),
		clearPluginRootsCache: () => {},
		compatibilityExemptionsPath: path.join(root, "compatibility.json"),
	});
	await manager.addMarketplace(marketplaceRoot);

	return {
		root,
		marketplaceRoot,
		installedRegistryPath: path.join(root, "installed_plugins.json"),
		pluginsCacheDir: path.join(root, "cache", "plugins"),
		manager,
	};
}

function installedVersion(manager: MarketplaceManager): Promise<string | undefined> {
	return manager.listInstalledPlugins().then(summaries => summaries[0]?.entries[0]?.version);
}

function installedEntry(manager: MarketplaceManager) {
	return manager.listInstalledPlugins().then(summaries => summaries[0]?.entries[0]);
}

describe("plugin version choices", () => {
	test("tag 列表新版本在前，并补齐 catalog 版本", async () => {
		const h = await setup();
		const { versions, sourceChanged } = await h.manager.pluginVersionChoices("hello-plugin", "test-marketplace");

		expect(versions.map(version => version.version)).toEqual(["2.0.0", "1.5.0", "1.0.0"]);
		// The ref is what the installer actually checks out.
		expect(versions[0]).toEqual({ version: "2.0.0", ref: "v2.0.0" });
		expect(sourceChanged).toBe(false);
	});

	test("同一个版本只出现一次（catalog 版本与 tag 归一后合并）", async () => {
		const h = await setup();
		const { versions } = await h.manager.pluginVersionChoices("hello-plugin", "test-marketplace");
		expect(new Set(versions.map(version => version.version)).size).toBe(versions.length);
	});
});

describe("installing a chosen version", () => {
	test("装目标版本时装的是该 tag 的内容，登记版本为目标版本", async () => {
		const h = await setup();
		const entry = await h.manager.installPlugin("hello-plugin", "test-marketplace", {
			targetVersion: "1.0.0",
		});

		expect(entry.version).toBe("1.0.0");
		expect(entry.installPath).toContain("___1.0.0");
		expect(fs.readFileSync(path.join(entry.installPath, "index.ts"), "utf8")).toContain("1.0.0");
		expect(entry.sourceRepo).toBe(path.resolve(h.marketplaceRoot));
		expect(entry.sourcePath).toBe("plugins/hello-plugin");
	});

	test("目标版本未发布时拒绝，且不留安装痕迹", async () => {
		const h = await setup();
		await expect(
			h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "9.9.9" }),
		).rejects.toThrow(/Version 9\.9\.9 is not published/);
		expect(await installedVersion(h.manager)).toBeUndefined();
	});
});

describe("upgrade to a chosen version", () => {
	test("从旧版升到指定新版本，旧缓存被清理", async () => {
		const h = await setup();
		const first = await h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "1.0.0" });

		const upgraded = await h.manager.upgradePlugin(PLUGIN_ID, "user", { targetVersion: "2.0.0" });

		expect(upgraded.version).toBe("2.0.0");
		expect(await installedVersion(h.manager)).toBe("2.0.0");
		expect(fs.existsSync(path.join(upgraded.installPath, "index.ts"))).toBe(true);
		expect(fs.existsSync(first.installPath)).toBe(false);
	});

	test("选中版本与 catalog 版本不同时，expectedVersion 仍按 catalog 校验", async () => {
		const h = await setup();
		await h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "1.0.0" });

		// The user read catalog 2.0.0 and picked the middle tag: the pinned
		// manifest says 1.5.0, so the trust gate must compare the catalog, not
		// the tag, or every non-latest choice would be rejected.
		const upgraded = await h.manager.upgradePlugin(PLUGIN_ID, "user", {
			targetVersion: "1.5.0",
			expectedVersion: "2.0.0",
		});
		expect(upgraded.version).toBe("1.5.0");
		expect(await installedVersion(h.manager)).toBe("1.5.0");
		const content = fs.readFileSync(path.join(upgraded.installPath, "index.ts"), "utf8");
		expect(content).toContain("1.5.0");
	});

	test("catalog 在确认后漂移时拒绝且保持旧版本", async () => {
		const h = await setup();
		await h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "1.0.0" });

		await expect(
			h.manager.upgradePlugin(PLUGIN_ID, "user", { targetVersion: "1.5.0", expectedVersion: "2.1.0" }),
		).rejects.toThrow(/changed since it was reviewed/);
		expect(await installedVersion(h.manager)).toBe("1.0.0");
	});

	test("降级被显式拒绝，已装版本与文件保持不动", async () => {
		const h = await setup();
		const current = await h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "2.0.0" });

		await expect(h.manager.upgradePlugin(PLUGIN_ID, "user", { targetVersion: "1.0.0" })).rejects.toThrow(
			/refusing to downgrade/,
		);
		expect(await installedVersion(h.manager)).toBe("2.0.0");
		expect(fs.existsSync(current.installPath)).toBe(true);
	});
});

describe("git source replacement", () => {
	test("catalog 换仓时拒绝，确认后按重新安装处理", async () => {
		const h = await setup();
		const current = await h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "2.0.0" });

		// A refreshed catalog that now points at another repository.
		fs.writeFileSync(
			path.join(h.root, "cache", "marketplaces", "test-marketplace", "marketplace.json"),
			JSON.stringify({
				name: "test-marketplace",
				owner: { name: "Test" },
				plugins: [
					{
						name: "hello-plugin",
						source: { source: "git-subdir", url: pathToFileURL(h.marketplaceRoot).href, path: "plugins/missing" },
						version: "2.0.0",
					},
				],
			}),
		);

		await expect(h.manager.upgradePlugin(PLUGIN_ID, "user")).rejects.toThrow(/requires an explicit reinstall/);
		expect(await installedVersion(h.manager)).toBe("2.0.0");
		expect(fs.existsSync(current.installPath)).toBe(true);

		// Confirmed as a reinstall: the guard steps aside and the install runs;
		// here it fails on the missing directory, which is not a source refusal.
		await expect(h.manager.upgradePlugin(PLUGIN_ID, "user", { allowReplace: true })).rejects.toThrow(
			/does not exist/,
		);
		expect(await installedVersion(h.manager)).toBe("2.0.0");
	});

	test("同仓换目录也算替换（同仓同目录才允许前进）", async () => {
		const h = await setup();
		await h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "2.0.0" });

		const registry = JSON.parse(fs.readFileSync(h.installedRegistryPath, "utf8")) as {
			plugins: Record<string, Array<{ sourcePath?: string }>>;
		};
		registry.plugins[PLUGIN_ID]![0]!.sourcePath = "plugins/other";
		fs.writeFileSync(h.installedRegistryPath, JSON.stringify(registry));

		await expect(h.manager.upgradePlugin(PLUGIN_ID, "user")).rejects.toThrow(/requires an explicit reinstall/);
	});
});

describe("upgrade rollback", () => {
	test("落定前失败时登记表与旧缓存都回到旧版本", async () => {
		const h = await setup();
		const current = await h.manager.installPlugin("hello-plugin", "test-marketplace", { targetVersion: "1.0.0" });

		// The runtime lock file is a directory: installing the new files succeeds
		// and fails on its last step, exactly the window `retainPrevious` guards.
		const lockPath = path.join(path.dirname(h.installedRegistryPath), "musepi-plugins.lock.json");
		fs.rmSync(lockPath, { force: true });
		fs.mkdirSync(lockPath);

		await expect(h.manager.upgradePlugin(PLUGIN_ID, "user", { targetVersion: "2.0.0" })).rejects.toThrow();

		expect(await installedVersion(h.manager)).toBe("1.0.0");
		const restored = await installedEntry(h.manager);
		expect(restored?.installPath).toBe(current.installPath);
		expect(fs.existsSync(current.installPath)).toBe(true);
		// The half-installed new copy is not left behind.
		const caches = fs.readdirSync(h.pluginsCacheDir).filter(name => name.includes("___2.0.0"));
		expect(caches).toEqual([]);

		fs.rmSync(lockPath, { recursive: true, force: true });
	});
});

describe("no version information", () => {
	test("没有 tag 的仓库只给出 catalog 版本，升级仍按 latest 语义", async () => {
		const h = await setup();
		// A repository without tags: only the catalog version is selectable.
		const plainRoot = path.join(h.root, "plain-marketplace");
		fs.mkdirSync(plainRoot, { recursive: true });
		writePluginSource(plainRoot, "1.0.0");
		const manager = new MarketplaceManager({
			marketplacesRegistryPath: path.join(h.root, "plain-marketplaces.json"),
			installedRegistryPath: path.join(h.root, "plain-installed.json"),
			marketplacesCacheDir: path.join(h.root, "plain-cache", "marketplaces"),
			pluginsCacheDir: path.join(h.root, "plain-cache", "plugins"),
			clearPluginRootsCache: () => {},
			compatibilityExemptionsPath: path.join(h.root, "compatibility.json"),
		});
		await manager.addMarketplace(plainRoot);

		const { versions } = await manager.pluginVersionChoices("hello-plugin", "test-marketplace");
		expect(versions.map(version => version.version)).toEqual(["1.0.0"]);

		const id = buildPluginId("hello-plugin", "test-marketplace");
		await manager.installPlugin("hello-plugin", "test-marketplace");
		expect((await manager.listInstalledPlugins())[0]?.id).toBe(id);
	});
});
