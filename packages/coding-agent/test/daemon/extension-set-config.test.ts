/**
 * extensions.setConfig 写入链路契约(dsh 管理页五段式契约的 daemon 侧):
 * 1. 声明字段写入 → 经 coerceConfigFieldValue 钳制落盘 plugin-config-store,
 *    extensions.list 同帧重拉能看到钳制后的 configValues(乐观回读闭环)。
 * 2. 未声明的键直接拒绝(防写垃圾键),存储不留痕。
 * 3. 越界数字在写入时被夹取,不是原样落盘。
 * 4. 成功路径扇出 extensions.changed(GUI 重拉信号)。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { getAgentDir } from "@musepi/pi-utils";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { resetPluginConfigStoreCache } from "../../src/extensibility/extensions-center/plugin-config-store";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const EXT_ID = "extension-module:voice-input";

async function writeFixtureExtension(agentDir: string): Promise<void> {
	const dir = path.join(agentDir, "extensions", "voice-input");
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, "index.ts"), "export default function (): void {}\n");
	await Bun.write(
		path.join(dir, "package.json"),
		JSON.stringify({
			name: "voice-input",
			omp: {
				extensions: ["index.ts"],
				config: [
					{ key: "enabled", type: "boolean", default: true },
					{ key: "threshold", type: "number", default: 0.5, min: 0, max: 1 },
					{ key: "model", type: "select", default: "base", options: ["base", "large"], restart: "session" },
				],
			},
		}),
	);
}

describe("extensions.setConfig 写入链路", () => {
	let agentDir: string;
	let tmpCwd: string;
	let service: ExtensionService;
	let changedCount: number;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-set-config-");
	}, 30000);

	afterAll(async () => {
		resetPluginConfigStoreCache();
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	beforeEach(async () => {
		resetPluginConfigStoreCache();
		changedCount = 0;
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-set-config-cwd-"));
		await writeFixtureExtension(agentDir);
		// 每例清空存储文件,保证"拒绝写入不留痕"断言不被前例落盘污染。
		await fs.rm(path.join(agentDir, "extensions", "plugin-config.json"), { force: true });
		service = new ExtensionService({
			settings: () => Settings.isolated(),
			ensureRegistry: async () => {},
			cwd: () => tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			onChanged: () => {
				changedCount++;
			},
		});
	});

	test("写入声明字段 → 钳制落盘 → list 回读同值", async () => {
		const res = (await service.setConfig({ id: EXT_ID, key: "model", value: "large" })) as {
			restart: string;
			values: Record<string, unknown>;
		};
		expect(res.restart).toBe("session");
		expect(res.values.model).toBe("large");
		expect(changedCount).toBe(1);

		const listed = await service.getExtensions();
		const ext = listed.find(e => e.id === EXT_ID);
		expect(ext?.config?.map(f => f.key)).toEqual(["enabled", "threshold", "model"]);
		expect(ext?.configValues).toMatchObject({ enabled: true, threshold: 0.5, model: "large" });
	});

	test("越界数字在写入时被夹取到声明区间", async () => {
		await service.setConfig({ id: EXT_ID, key: "threshold", value: 42 });
		const ext = (await service.getExtensions()).find(e => e.id === EXT_ID);
		expect(ext?.configValues?.threshold).toBe(1);
	});

	test("未声明的键被拒绝,存储不留痕", async () => {
		await expect(service.setConfig({ id: EXT_ID, key: "rogue", value: 1 })).rejects.toThrow(
			/not a declared config field/,
		);
		expect(changedCount).toBe(0);
		const storePath = path.join(getAgentDir(), "extensions", "plugin-config.json");
		const exists = await Bun.file(storePath).exists();
		expect(exists).toBe(false);
	});

	test("未知扩展 id 同样被拒绝", async () => {
		await expect(service.setConfig({ id: "extension-module:ghost", key: "enabled", value: true })).rejects.toThrow(
			/not a declared config field/,
		);
	});
});
