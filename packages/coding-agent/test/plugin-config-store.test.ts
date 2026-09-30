import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getPluginConfigPath,
	readPluginConfigStore,
	resetPluginConfigStoreCache,
	writePluginConfigValue,
} from "../src/extensibility/extensions-center/plugin-config-store";

/**
 * 插件配置存储契约:写穿透落盘、读回同形;损坏文件按空存储处理(fail-soft,
 * 绝不抛错阻断扩展登记);非对象条目被丢弃。失败模式:daemon 重启或并发
 * 写后,读到的必须是自己写的字节,而不是缓存幻影或解析残骸。
 */
describe("plugin-config-store", () => {
	let dir: string;
	let storePath: string;

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plugin-config-store-"));
		storePath = path.join(dir, "extensions", "plugin-config.json");
		resetPluginConfigStoreCache();
	});

	afterEach(async () => {
		resetPluginConfigStoreCache();
		await fs.rm(dir, { recursive: true, force: true });
	});

	test("absent store reads as empty and write creates the file", async () => {
		expect(await readPluginConfigStore(storePath)).toEqual({});
		await writePluginConfigValue("extension-module:voice", "enabled", true, storePath);
		const raw = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, Record<string, unknown>>;
		expect(raw["extension-module:voice"]).toEqual({ enabled: true });
	});

	test("writes per extension accumulate without clobbering other extensions", async () => {
		await writePluginConfigValue("extension-module:voice", "enabled", true, storePath);
		await writePluginConfigValue("extension-module:voice", "threshold", 0.7, storePath);
		await writePluginConfigValue("extension-module:pet", "mood", "calm", storePath);
		expect(await readPluginConfigStore(storePath)).toEqual({
			"extension-module:voice": { enabled: true, threshold: 0.7 },
			"extension-module:pet": { mood: "calm" },
		});
	});

	test("returns the written extension's value table", async () => {
		await writePluginConfigValue("extension-module:a", "x", 1, storePath);
		const values = await writePluginConfigValue("extension-module:a", "y", 2, storePath);
		expect(values).toEqual({ x: 1, y: 2 });
	});

	test("a corrupt store file degrades to empty instead of throwing", async () => {
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(storePath, "{ not json");
		expect(await readPluginConfigStore(storePath)).toEqual({});
	});

	test("non-object rows and non-object top-level values are dropped fail-soft", async () => {
		await fs.mkdir(path.dirname(storePath), { recursive: true });
		await fs.writeFile(
			storePath,
			JSON.stringify({
				"extension-module:good": { k: 1 },
				"extension-module:bad": "not-an-object",
				alsoBad: [1, 2],
			}),
		);
		expect(await readPluginConfigStore(storePath)).toEqual({ "extension-module:good": { k: 1 } });
	});

	test("default path lives under the agent dir extensions folder", () => {
		expect(getPluginConfigPath().replace(/\\/g, "/")).toMatch(/\/extensions\/plugin-config\.json$/);
	});
});
