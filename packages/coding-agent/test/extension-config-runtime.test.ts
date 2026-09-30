/**
 * pi.config 运行时消费契约(⑥ cordis 插件化第三刀):
 * 1. 扩展工厂内 pi.config.get/getAll 读到「清单声明默认值 ← 存储值」的
 *    钳制合并——与扩展中心表单、setConfig 写入共用同一条 coerce 链路。
 * 2. 未声明的键读到 undefined(get)/不进表(getAll);存储坏值回退默认。
 * 3. 清单无 config 声明的扩展读到空表,不抛错。
 * 失败模式:扩展作者改了表单值,运行时却拿到旧值/原始坏值。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { resetPluginConfigStoreCache } from "../src/extensibility/extensions-center/plugin-config-store";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

let probeOut = "";

async function writeFixture(agentDir: string, name: string, manifest: Record<string, unknown> | null): Promise<string> {
	const dir = path.join(agentDir, "extensions", name);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(
		path.join(dir, "index.ts"),
		`export default async function (pi: any): Promise<void> {
			const [threshold, model, ghost, all] = await Promise.all([
				pi.config.get("threshold"),
				pi.config.get("model"),
				pi.config.get("ghost"),
				pi.config.getAll(),
			]);
			await Bun.write(process.env.PROBE_OUT!, JSON.stringify({ threshold, model, ghost, all }));
		}\n`,
	);
	if (manifest) {
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ name, omp: manifest }));
	}
	return path.join(dir, "index.ts");
}

async function loadAndRead(entry: string, cwd: string): Promise<Record<string, unknown>> {
	const result = await loadExtensions([entry], cwd);
	expect(result.errors).toEqual([]);
	const raw = await Bun.file(probeOut).text();
	return JSON.parse(raw) as Record<string, unknown>;
}

describe("pi.config 运行时读取", () => {
	let agentDir: string;
	let cwd: string;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-config-runtime-");
	}, 30000);

	afterAll(async () => {
		resetPluginConfigStoreCache();
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	beforeEach(async () => {
		resetPluginConfigStoreCache();
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-config-runtime-cwd-"));
		probeOut = path.join(cwd, "probe.json");
		process.env.PROBE_OUT = probeOut;
		// 每例清空存储与旧探针,隔离用例。
		await fs.rm(path.join(agentDir, "extensions", "plugin-config.json"), { force: true });
	});

	const CONFIG_MANIFEST = {
		extensions: ["index.ts"],
		config: [
			{ key: "enabled", type: "boolean", default: true },
			{ key: "threshold", type: "number", default: 0.5, min: 0, max: 1 },
			{ key: "model", type: "select", default: "base", options: ["base", "large"] },
		],
	};

	test("未写存储时读到声明默认值,未声明键为 undefined", async () => {
		const entry = await writeFixture(agentDir, "voice-input", CONFIG_MANIFEST);
		const probe = await loadAndRead(entry, cwd);
		expect(probe.threshold).toBe(0.5);
		expect(probe.model).toBe("base");
		expect(probe.ghost).toBeUndefined();
		expect(probe.all).toEqual({ enabled: true, threshold: 0.5, model: "base" });
	});

	test("存储值覆盖默认值;坏存储值回退默认而不透出", async () => {
		const entry = await writeFixture(agentDir, "voice-input", CONFIG_MANIFEST);
		const storePath = path.join(agentDir, "extensions", "plugin-config.json");
		await Bun.write(
			storePath,
			JSON.stringify({
				"extension-module:voice-input": { threshold: 0.8, model: "turbo", rogue: "x" },
			}),
		);
		resetPluginConfigStoreCache();
		const probe = await loadAndRead(entry, cwd);
		expect(probe.threshold).toBe(0.8);
		expect(probe.model).toBe("base"); // 未声明的 select 选项 → 回退默认
		expect(probe.all).toEqual({ enabled: true, threshold: 0.8, model: "base" }); // rogue 键被清单过滤
	});

	test("清单无 config 声明的扩展读到空表且不抛错", async () => {
		const entry = await writeFixture(agentDir, "plain-ext", { extensions: ["index.ts"] });
		const probe = await loadAndRead(entry, cwd);
		expect(probe.ghost).toBeUndefined();
		expect(probe.all).toEqual({});
	});

	test("restart=none 语义:写入后同进程再次读取拿到新值", async () => {
		const entry = await writeFixture(agentDir, "voice-input", CONFIG_MANIFEST);
		await loadAndRead(entry, cwd);
		// 模拟 GUI 表单写入(setConfig 的落点)。
		const { writePluginConfigValue } = await import("../src/extensibility/extensions-center/plugin-config-store");
		await writePluginConfigValue("extension-module:voice-input", "threshold", 0.3);
		const probe = await loadAndRead(entry, cwd);
		expect(probe.threshold).toBe(0.3);
	});
});
