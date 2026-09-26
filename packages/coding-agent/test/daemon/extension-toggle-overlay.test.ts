/**
 * M2-2.3 契约测试：enable/disable 是纯覆盖层语义。
 *
 * 契约（0.5.0-roadmap M2-2.3，dsh patch 语义对齐）：
 * 1. toggle 前后插件内容物字节不动 —— 递归 sha256（文件名清单 + 文件内容）
 *    跨 toggle 全等。选递归哈希而非 mtime：Windows 上读取/防病毒扫描会漂移
 *    mtime 而内容不变，哈希直接证明"字节不动"。
 * 2. 覆盖层 diff 只含目标 id 的增/删 —— disabledExtensions / mcp.json
 *    denylist / musepi-plugins.lock.json 的变更都恰好围绕被 toggle 的 id，
 *    不引入冗余快照，也不触碰其他条目。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { PluginManager } from "@musepi/pi-coding-agent/extensibility/plugins/manager";
import * as piUtils from "@musepi/pi-utils";
import { getMCPConfigPath, removeWithRetries } from "@musepi/pi-utils";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/** 递归目录摘要：排序后的相对路径清单 + 每个文件内容的 sha256 联合摘要。 */
async function dirDigest(dir: string): Promise<string> {
	const entries: { rel: string; isDir: boolean }[] = [];
	async function walk(rel: string): Promise<void> {
		const abs = path.join(dir, rel);
		for (const entry of await fs.readdir(abs, { withFileTypes: true })) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			const isDir = entry.isDirectory();
			entries.push({ rel: childRel, isDir });
			if (isDir) await walk(childRel);
		}
	}
	await walk("");
	entries.sort((a, b) => a.rel.localeCompare(b.rel));
	const hasher = new Bun.CryptoHasher("sha256");
	for (const entry of entries) {
		hasher.update(entry.isDir ? "d" : "f");
		hasher.update(entry.rel);
		if (!entry.isDir) {
			hasher.update(new Uint8Array(await Bun.file(path.join(dir, entry.rel)).arrayBuffer()));
		}
	}
	return hasher.digest("hex");
}

function makeService(settings: Settings, cwd: string, agentDir: string): ExtensionService {
	return new ExtensionService({
		settings: () => settings,
		ensureRegistry: async () => {},
		cwd: () => cwd,
		webUrl: () => null,
		webPortFile: () => path.join(agentDir, "web.port"),
		onChanged: () => {},
	});
}

async function makeSkillDir(root: string): Promise<string> {
	const dir = path.join(root, ".omp", "skills", "commit-helper");
	await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
	await Bun.write(path.join(dir, "SKILL.md"), "---\nname: commit-helper\n---\n# commit helper\n");
	await Bun.write(path.join(dir, "scripts", "run.sh"), "echo hi\n");
	return dir;
}

// ═══════════════════════════════════════════════════════════════════════════
// 覆盖层语义：通用条目（settings.disabledExtensions）
// ═══════════════════════════════════════════════════════════════════════════

describe("extension toggle — disabledExtensions 覆盖层（M2-2.3）", () => {
	let tmpCwd: string;
	let agentDir: string;

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-toggle-overlay-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-toggle-overlay-agent-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpCwd);
		await removeWithRetries(agentDir);
	});

	test("disable→enable 循环：技能目录字节不动，覆盖层恰好增删该 id", async () => {
		const settings = Settings.isolated();
		const service = makeService(settings, tmpCwd, agentDir);
		const skillDir = await makeSkillDir(tmpCwd);
		const before = await dirDigest(skillDir);

		await service.setEnabled({ id: "skill:commit-helper", enabled: false });
		expect(await dirDigest(skillDir)).toBe(before);
		expect(settings.get("disabledExtensions")).toEqual(["skill:commit-helper"]);

		await service.setEnabled({ id: "skill:commit-helper", enabled: true });
		expect(await dirDigest(skillDir)).toBe(before);
		expect(settings.get("disabledExtensions")).toEqual([]);
	});

	test("已有其他禁用项时，diff 仍只含目标 id 的增/删", async () => {
		// 预置值必须经 set() 进 global 层——isolated(overrides) 落在 overrides
		// 顶层，会在 merge 里盖住后续 set()（该层语义是"最高优先覆盖"）。
		const settings = Settings.isolated();
		settings.set("disabledExtensions", ["rule:other"]);
		const service = makeService(settings, tmpCwd, agentDir);

		await service.setEnabled({ id: "skill:commit-helper", enabled: false });
		expect(settings.get("disabledExtensions")).toEqual(["rule:other", "skill:commit-helper"]);

		await service.setEnabled({ id: "skill:commit-helper", enabled: true });
		expect(settings.get("disabledExtensions")).toEqual(["rule:other"]);
	});

	test("镜像设置内置项 toggle 写设置键，不污染 disabledExtensions", async () => {
		const settings = Settings.isolated();
		const service = makeService(settings, tmpCwd, agentDir);

		await service.setEnabled({ id: "style:task-card-swarm", enabled: false });
		expect(settings.getRaw("display.taskCardStyle")).toBe("classic");
		expect(settings.get("disabledExtensions")).toEqual([]);

		await service.setEnabled({ id: "style:task-card-swarm", enabled: true });
		expect(settings.getRaw("display.taskCardStyle")).toBe("swarm");
		expect(settings.get("disabledExtensions")).toEqual([]);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 覆盖层语义：MCP（mcp.json denylist / 条目 enabled 标志）
// ═══════════════════════════════════════════════════════════════════════════

describe("extension toggle — mcp.json 覆盖层（M2-2.3）", () => {
	let isolatedAgentDir: string;
	let tmpCwd: string;
	let service: ExtensionService;

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("omp-toggle-overlay-mcp-");
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30000);

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-toggle-overlay-mcp-cwd-"));
		// getMCPConfigPath("user") 已被 agent-dir 隔离解析进临时树
		await Bun.write(
			path.join(isolatedAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					alpha: { type: "stdio", command: "echo" },
					beta: { type: "stdio", command: "echo" },
				},
			}),
		);
		service = makeService(Settings.isolated(), tmpCwd, isolatedAgentDir);
	});

	afterEach(async () => {
		await removeWithRetries(tmpCwd);
	});

	test("可写源条目 toggle：只翻该条目的 enabled 标志，其余条目不动", async () => {
		const userMcp = getMCPConfigPath("user", tmpCwd);
		const before = await Bun.file(userMcp).json();

		await service.setEnabled({ id: "mcp:alpha", enabled: false });
		const afterDisable = await Bun.file(userMcp).json();
		expect(afterDisable.mcpServers.alpha.enabled).toBe(false);
		expect(afterDisable.mcpServers.beta).toEqual(before.mcpServers.beta);
		expect(afterDisable.disabledServers).toBeUndefined();
		expect(afterDisable.enabledServers).toBeUndefined();

		await service.setEnabled({ id: "mcp:alpha", enabled: true });
		const afterEnable = await Bun.file(userMcp).json();
		expect(afterEnable.mcpServers.alpha.enabled).toBe(true);
		expect(afterEnable.mcpServers.beta).toEqual(before.mcpServers.beta);
		expect(afterEnable.disabledServers).toBeUndefined();
		expect(afterEnable.enabledServers).toBeUndefined();
	});

	test("纯发现源 toggle：denylist 纯增量，不落 server 定义快照", async () => {
		const userMcp = getMCPConfigPath("user", tmpCwd);

		await service.setEnabled({ id: "mcp:ghost", enabled: false });
		const disabled = await Bun.file(userMcp).json();
		expect(Object.keys(disabled).sort()).toEqual(["$schema", "disabledServers", "mcpServers"]);
		expect(disabled.disabledServers).toEqual(["ghost"]);
		expect(disabled.mcpServers.ghost).toBeUndefined();

		await service.setEnabled({ id: "mcp:ghost", enabled: true });
		const enabled = await Bun.file(userMcp).json();
		expect(enabled.disabledServers).toBeUndefined();
		expect(enabled.enabledServers).toEqual(["ghost"]);
		expect(enabled.mcpServers.ghost).toBeUndefined();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// 覆盖层语义：插件包（musepi-plugins.lock.json）
// ═══════════════════════════════════════════════════════════════════════════

describe("plugin toggle — musepi-plugins.lock.json 覆盖层（M2-2.3）", () => {
	let tmpRoot: string;
	let lockfile: string;
	let pluginDir: string;
	let manager: PluginManager;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-toggle-overlay-plugin-"));
		lockfile = path.join(tmpRoot, "musepi-plugins.lock.json");
		pluginDir = path.join(tmpRoot, "hello-plugin");
		await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "hello-plugin", version: "1.0.0" }),
		);
		await Bun.write(path.join(pluginDir, "dist", "index.js"), "export default 1;\n");

		spyOn(piUtils, "getPluginsDir").mockReturnValue(tmpRoot);
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(lockfile);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(tmpRoot, "node_modules"));
		manager = new PluginManager(tmpRoot);
	});

	afterEach(async () => {
		mock.restore();
		await removeWithRetries(tmpRoot);
	});

	test("disable→enable：插件目录字节不动，lockfile 只翻该插件的 enabled", async () => {
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: { "hello-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } },
				settings: { "hello-plugin": { "autoContext.enabled": true } },
			}),
		);
		const before = await dirDigest(pluginDir);

		await manager.setPluginEnabled("hello-plugin", false);
		expect(await dirDigest(pluginDir)).toBe(before);
		const disabledLock = await Bun.file(lockfile).json();
		expect(disabledLock.plugins["hello-plugin"]).toEqual({
			version: "1.0.0",
			enabledFeatures: null,
			enabled: false,
		});
		expect(disabledLock.settings).toEqual({ "hello-plugin": { "autoContext.enabled": true } });

		await manager.setPluginEnabled("hello-plugin", true);
		expect(await dirDigest(pluginDir)).toBe(before);
		const enabledLock = await Bun.file(lockfile).json();
		expect(enabledLock.plugins["hello-plugin"].enabled).toBe(true);
	});

	test("lockfile 无条目时 disable 只新增该插件的覆盖层条目", async () => {
		await Bun.write(
			lockfile,
			JSON.stringify({
				plugins: { "hello-plugin": { version: "1.0.0", enabledFeatures: null, enabled: true } },
				settings: {},
			}),
		);
		const before = await dirDigest(pluginDir);

		await manager.setPluginEnabled("fresh-plugin", false);

		expect(await dirDigest(pluginDir)).toBe(before);
		const lock = await Bun.file(lockfile).json();
		expect(lock.plugins["fresh-plugin"].enabled).toBe(false);
		expect(lock.plugins["hello-plugin"].enabled).toBe(true);
	});
});
