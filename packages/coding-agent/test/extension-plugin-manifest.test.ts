import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readExtensionPluginMeta } from "../src/extensibility/extensions/plugin-manifest";

/**
 * readExtensionPluginMeta 契约:从扩展入口向上解析最近带 omp/pi 字段的
 * package.json,config/resources 经 pi-wire fail-soft 校验后成为管理页元数据。
 * 失败模式:manifest 缺失/损坏/未声明时必须返回 null(不是插件声明),
 * 绝不能抛错阻断扩展登记。
 */
describe("readExtensionPluginMeta", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-manifest-"));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function writeExtension(files: Record<string, string>): Promise<string> {
		for (const [rel, content] of Object.entries(files)) {
			const target = path.join(dir, rel);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.writeFile(target, content);
		}
		return path.join(dir, "index.ts");
	}

	test("returns null when no package.json exists anywhere up the tree", async () => {
		const entry = await writeExtension({ "index.ts": "export default {}" });
		expect(await readExtensionPluginMeta(entry)).toBeNull();
	});

	test("returns null when package.json declares no omp/pi block", async () => {
		const entry = await writeExtension({
			"index.ts": "export default {}",
			"package.json": JSON.stringify({ name: "plain-ext", version: "1.0.0" }),
		});
		expect(await readExtensionPluginMeta(entry)).toBeNull();
	});

	test("parses well-formed config fields and resources from the omp block", async () => {
		const entry = await writeExtension({
			"index.ts": "export default {}",
			"package.json": JSON.stringify({
				name: "voice-input",
				omp: {
					extensions: ["index.ts"],
					config: [
						{ key: "enabled", type: "boolean", default: true, description: "Enable voice input" },
						{ key: "threshold", type: "number", default: 0.5, min: 0, max: 1, step: 0.05 },
						{
							key: "model",
							type: "select",
							default: "base",
							options: ["base", "large"],
							restart: "session",
						},
					],
					resources: {
						disk: "120MB",
						memory: "350MB",
						setupMinutes: 2,
						models: [{ name: "stt-base", size: "75MB" }],
					},
				},
			}),
		});
		const meta = await readExtensionPluginMeta(entry);
		expect(meta).not.toBeNull();
		expect(meta!.fields.map(f => f.key)).toEqual(["enabled", "threshold", "model"]);
		expect(meta!.fields[2]!.restart).toBe("session");
		expect(meta!.configErrors).toEqual([]);
		expect(meta!.resources?.disk).toBe("120MB");
		expect(meta!.resources?.models).toHaveLength(1);
	});

	test("drops malformed fields individually while keeping good ones (fail-soft)", async () => {
		const entry = await writeExtension({
			"index.ts": "export default {}",
			"package.json": JSON.stringify({
				omp: {
					config: [
						{ key: "good", type: "boolean", default: true },
						{ key: "bad-type", type: "teleport", default: 1 },
						"not-an-object",
					],
				},
			}),
		});
		const meta = await readExtensionPluginMeta(entry);
		expect(meta).not.toBeNull();
		expect(meta!.fields.map(f => f.key)).toEqual(["good"]);
		expect(meta!.configErrors.length).toBe(2);
		expect(meta!.configErrors.map(e => e.code)).toContain("field-bad-type");
		expect(meta!.configErrors.map(e => e.code)).toContain("field-not-an-object");
	});

	test("treats a corrupt package.json as no plugin declaration instead of throwing", async () => {
		const entry = await writeExtension({
			"index.ts": "export default {}",
			"package.json": "{ not valid json",
		});
		expect(await readExtensionPluginMeta(entry)).toBeNull();
	});

	test("finds the manifest one directory above a nested entry file", async () => {
		const entry = await writeExtension({
			"src/deep/entry.ts": "export default {}",
			"package.json": JSON.stringify({ omp: { config: [{ key: "flag", type: "boolean", default: false }] } }),
		});
		const meta = await readExtensionPluginMeta(path.join(dir, "src", "deep", "entry.ts"));
		expect(meta).not.toBeNull();
		expect(meta!.fields.map(f => f.key)).toEqual(["flag"]);
	});
});
