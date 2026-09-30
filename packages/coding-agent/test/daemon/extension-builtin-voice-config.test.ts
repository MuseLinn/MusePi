/**
 * 内置语音插件单元(voice:stt / voice:tts)的 dsh 式管理页契约:
 * 1. extensions.list 给内置单元挂注册表声明的 config 字段 + 从设置读出
 *    的 configValues(字段键即设置键,与设置页同一条存储)。
 * 2. extensions.setConfig 对内置单元按声明钳制后经 settings 落盘——
 *    list 同帧回读看到新值(乐观回读闭环)。
 * 3. 越界数字(tts.rate > 2)写入时被夹取,不是原样落盘。
 * 4. 未声明的键直接拒绝,设置不留痕、不扇出 changed。
 * 5. extensions.setEnabled 走 settingsMirror 分支写 stt.enabled 总开关。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const STT_ID = "voice:stt";
const TTS_ID = "voice:tts";

describe("内置语音插件单元(voice:stt / voice:tts)", () => {
	let agentDir: string;
	let tmpCwd: string;
	let service: ExtensionService;
	let settings: Settings;
	let changedCount: number;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-builtin-voice-");
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	beforeEach(async () => {
		changedCount = 0;
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-voice-cwd-"));
		settings = Settings.isolated();
		service = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => {},
			cwd: () => tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			onChanged: () => {
				changedCount++;
			},
		});
	});

	test("list 给内置语音单元挂声明字段 + 设置值(configValues)", async () => {
		settings.set("stt.modelName" as Parameters<Settings["set"]>[0], "sensevoice" as never);
		const listed = await service.list();
		const stt = listed.extensions.find(e => e.id === STT_ID);
		expect(stt).toBeDefined();
		expect(stt?.builtin).toBe(true);
		expect(stt?.config?.map(f => f.key)).toEqual([
			"stt.modelName",
			"stt.language",
			"stt.vadEndMs",
			"stt.submitTrigger",
		]);
		expect(stt?.configValues?.["stt.modelName"]).toBe("sensevoice");
		expect(stt?.configValues?.["stt.vadEndMs"]).toBe(700);

		const tts = listed.extensions.find(e => e.id === TTS_ID);
		expect(tts?.config?.map(f => f.key)).toEqual([
			"tts.localModel",
			"tts.localVoice",
			"tts.rate",
			"tts.inputMode",
			"tts.autoRead",
		]);
		expect(tts?.configValues?.["tts.rate"]).toBe(1);
	});

	test("setConfig 经 settings 落盘 → list 同帧回读(闭环)", async () => {
		const res = (await service.setConfig({ id: TTS_ID, key: "tts.rate", value: 1.5 })) as { restart: string };
		expect(res.restart).toBe("none");
		expect(settings.getRaw("tts.rate")).toBe(1.5);
		expect(changedCount).toBe(1);

		const listed = await service.list();
		const tts = listed.extensions.find(e => e.id === TTS_ID);
		expect(tts?.configValues?.["tts.rate"]).toBe(1.5);
	});

	test("越界数字写入时被夹取到声明区间", async () => {
		await service.setConfig({ id: TTS_ID, key: "tts.rate", value: 42 });
		expect(settings.getRaw("tts.rate")).toBe(2);
	});

	test("未声明的键被拒绝:设置不留痕、不扇出 changed", async () => {
		await expect(service.setConfig({ id: STT_ID, key: "rogue", value: 1 })).rejects.toThrow(
			/not a declared config field/,
		);
		expect(changedCount).toBe(0);
		expect(settings.getRaw("rogue" as never)).toBeUndefined();
	});

	test("setEnabled 走 settingsMirror:写 stt.enabled 总开关,状态随设置翻转", async () => {
		await service.setEnabled({ id: STT_ID, enabled: true });
		expect(settings.getRaw("stt.enabled")).toBe(true);
		let stt = (await service.list()).extensions.find(e => e.id === STT_ID);
		expect(stt?.state).toBe("active");

		await service.setEnabled({ id: STT_ID, enabled: false });
		expect(settings.getRaw("stt.enabled")).toBe(false);
		stt = (await service.list()).extensions.find(e => e.id === STT_ID);
		expect(stt?.state).toBe("disabled");
	});
});

describe("更多内置子系统插件单元(terminal/browser/computer/lsp)", () => {
	let agentDir: string;
	let tmpCwd: string;
	let service: ExtensionService;
	let settings: Settings;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-builtin-subs-");
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-subs-cwd-"));
		settings = Settings.isolated();
		service = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => {},
			cwd: () => tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			onChanged: () => {},
		});
	});

	test("terminal 只读单元:无禁用语义 + 配置字段即 terminal.* 设置键", async () => {
		const listed = await service.list();
		const term = listed.extensions.find(e => e.id === "terminal:terminal");
		expect(term).toBeDefined();
		expect(term?.readonly).toBe(true);
		expect(term?.builtin).toBe(true);
		expect(term?.config?.map(f => f.key)).toEqual([
			"terminal.provider",
			"terminal.showImages",
			"terminal.showProgress",
		]);
		expect(term?.configValues?.["terminal.provider"]).toBe("auto");
		// 只读项 setEnabled 不应存在语义:仍走通用 disabledExtensions 分支(不发明设置键)。
		await service.setConfig({ id: "terminal:terminal", key: "terminal.showImages", value: false });
		expect(settings.getRaw("terminal.showImages")).toBe(false);
	});

	test("browser 单元:镜像 browser.enabled,配置写入经 settings 落盘", async () => {
		const listed = await service.list();
		const browser = listed.extensions.find(e => e.id === "browser:browser");
		expect(browser?.state).toBe("active");

		await service.setEnabled({ id: "browser:browser", enabled: false });
		expect(settings.getRaw("browser.enabled")).toBe(false);
		const after = (await service.list()).extensions.find(e => e.id === "browser:browser");
		expect(after?.state).toBe("disabled");

		await service.setConfig({ id: "browser:browser", key: "browser.headless", value: false });
		expect(settings.getRaw("browser.headless")).toBe(false);
	});

	test("computer 默认关闭:镜像 default false,状态如实上报 disabled", async () => {
		const listed = await service.list();
		const computer = listed.extensions.find(e => e.id === "computer:computer");
		expect(computer?.state).toBe("disabled");
		expect(computer?.disabledReason).toBe("item-disabled");

		await service.setEnabled({ id: "computer:computer", enabled: true });
		const after = (await service.list()).extensions.find(e => e.id === "computer:computer");
		expect(after?.state).toBe("active");
		expect(settings.getRaw("computer.enabled")).toBe(true);
	});

	test("lsp 单元:镜像 lsp.enabled + 配置字段即 lsp.* 设置键", async () => {
		const listed = await service.list();
		const lsp = listed.extensions.find(e => e.id === "lsp:lsp");
		expect(lsp?.state).toBe("active");
		expect(lsp?.config?.map(f => f.key)).toEqual(["lsp.lazy", "lsp.shared"]);
		await service.setConfig({ id: "lsp:lsp", key: "lsp.lazy", value: false });
		expect(settings.getRaw("lsp.lazy")).toBe(false);
	});
});
