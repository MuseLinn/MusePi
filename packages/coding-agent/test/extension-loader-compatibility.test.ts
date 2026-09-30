/**
 * 回退保护② · 会话装配入口（loadExtensions）兼容性预检契约：
 * 不兼容扩展在 import 之前被拦下——errors[] 带结构化诊断、扩展缺席、
 * 入口模块零副作用（探针文件不写）；授予豁免后同一入口放行装载。
 *
 * Why this exists: 预检若发生在 import 之后，不兼容插件的顶层副作用
 *  （连兼容判定都轮不到）已经执行——崩溃/丢数据窗口真实存在；若拒绝
 *  路径仍进 extensions[]，调用方会把「拒绝」当「在役」。
 *
 * A regression means: the refused extension's top-level side effects run,
 *  or the refusal does not surface in errors / the exemption does not admit.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@musepi/pi-utils";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { resolveCompatibilityPath } from "../src/extensibility/plugins/compatibility-store";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const PLUGIN = "loader-compat";
const ENTRY = "index.ts";

describe("loadExtensions 兼容性预检（回退保护② · 会话装配入口）", () => {
	let agentDir: string;
	let cwd: string;
	let entryPath: string;
	let probeOut: string;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("loader-compat-");
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "loader-compat-cwd-"));
		probeOut = path.join(cwd, "probe.json");
		const pluginDir = path.join(agentDir, "extensions", PLUGIN);
		await fs.mkdir(pluginDir, { recursive: true });
		// 顶层副作用探针：任何 import 发生即写文件——预检在 import 前的
		// 证据就是「拒绝时探针不存在」。
		await fs.writeFile(
			path.join(pluginDir, ENTRY),
			`await Bun.write(${JSON.stringify(probeOut)}, JSON.stringify({ loaded: true }));\nexport default function () {}\n`,
		);
		await fs.writeFile(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: PLUGIN,
				version: "1.0.0",
				peerDependencies: { "@musepi/pi-coding-agent": "^99.0.0" },
				musepi: { extensions: [`./${ENTRY}`] },
			}),
		);
		entryPath = path.join(pluginDir, ENTRY);
	}, 30_000);

	afterAll(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("拒绝：errors[] 带诊断、extensions 缺席、入口模块零副作用（未 import）", async () => {
		const result = await loadExtensions([entryPath], cwd);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(entryPath);
		expect(result.errors[0]?.error).toContain("^99.0.0");
		expect(result.errors[0]?.error).toContain("incompatible");
		// 探针未写 = import 未发生 = 预检真正先于副作用。
		expect(await Bun.file(probeOut).exists()).toBe(false);
	});

	it("授予精确版本豁免 → 同一入口放行装载（探针写入 = 真实 import）", async () => {
		const exemptionPath = resolveCompatibilityPath();
		await fs.writeFile(exemptionPath, `${JSON.stringify({ [`${PLUGIN}@1.0.0`]: [VERSION] })}\n`);

		const result = await loadExtensions([entryPath], cwd);
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(await Bun.file(probeOut).exists()).toBe(true);
	});
});
