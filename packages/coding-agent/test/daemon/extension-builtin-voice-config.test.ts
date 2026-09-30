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

describe("插件「包含的组件」契约(components + setComponentEnabled)", () => {
	let agentDir: string;
	let tmpCwd: string;
	let service: ExtensionService;
	let settings: Settings;
	let changedCount: number;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-builtin-components-");
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	beforeEach(async () => {
		changedCount = 0;
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-builtin-components-cwd-"));
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

	test("list 给声明组件的单元挂组件状态(browser/computer/lsp/voice 有,terminal 无)", async () => {
		const listed = await service.list();
		const browser = listed.extensions.find(e => e.id === "browser:browser");
		expect(browser?.components?.map(c => c.id)).toEqual(["browser"]);
		expect(browser?.components?.[0].enabled).toBe(true);
		expect(browser?.components?.[0].canToggle).toBe(true);

		const lsp = listed.extensions.find(e => e.id === "lsp:lsp");
		expect(lsp?.components?.map(c => c.id)).toEqual(["lsp"]);

		// voice 单元声明引擎组件(stt: whisper/sensevoice/parakeet;tts: 两模型)。
		const stt = listed.extensions.find(e => e.id === "voice:stt");
		expect(stt?.components?.map(c => c.id)).toEqual(["whisper", "sensevoice", "parakeet"]);
		const tts = listed.extensions.find(e => e.id === "voice:tts");
		expect(tts?.components?.map(c => c.id)).toEqual(["kokoro", "melotts-zh"]);

		const term = listed.extensions.find(e => e.id === "terminal:terminal");
		expect(term?.components).toBeUndefined();
	});

	test("组件开关写 tools.disabled 黑名单:list 同帧回读翻转 + changed 扇出", async () => {
		await service.setComponentEnabled({ id: "browser:browser", component: "browser", enabled: false });
		expect(settings.getRaw("tools.disabled")).toEqual(["browser"]);
		expect(changedCount).toBe(1);

		const after = (await service.list()).extensions.find(e => e.id === "browser:browser");
		expect(after?.components?.[0].enabled).toBe(false);
		expect(after?.components?.[0].disabledReason).toBe("tools-denied");
		// 单元总开关不受组件开关影响(正交)。
		expect(after?.state).toBe("active");

		await service.setComponentEnabled({ id: "browser:browser", component: "browser", enabled: true });
		expect(settings.getRaw("tools.disabled")).toEqual([]);
		const restored = (await service.list()).extensions.find(e => e.id === "browser:browser");
		expect(restored?.components?.[0].enabled).toBe(true);
		expect(restored?.components?.[0].disabledReason).toBeUndefined();
	});

	test("未声明组件直接拒绝,黑名单不留痕", async () => {
		await expect(
			service.setComponentEnabled({ id: "terminal:terminal", component: "browser", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		await expect(
			service.setComponentEnabled({ id: "browser:browser", component: "rogue", enabled: false }),
		).rejects.toThrow(/not a declared component/);
		expect(settings.getRaw("tools.disabled") ?? []).toEqual([]);
	});

	test("语音引擎组件开关写 voice.disabledEngines(独立于 tools 通道)", async () => {
		await service.setComponentEnabled({ id: "voice:stt", component: "sensevoice", enabled: false });
		expect(settings.getRaw("voice.disabledEngines")).toEqual(["stt:sensevoice"]);
		// 双通道正交:工具黑名单不被语音开关污染。
		expect(settings.getRaw("tools.disabled") ?? []).toEqual([]);

		const after = (await service.list()).extensions.find(e => e.id === "voice:stt");
		const sensevoice = after?.components?.find(c => c.id === "sensevoice");
		expect(sensevoice?.enabled).toBe(false);
		expect(sensevoice?.disabledReason).toBe("tools-denied");
		const whisper = after?.components?.find(c => c.id === "whisper");
		expect(whisper?.enabled).toBe(true);

		await service.setComponentEnabled({ id: "voice:tts", component: "melotts-zh", enabled: false });
		expect(settings.getRaw("voice.disabledEngines")).toEqual(["stt:sensevoice", "tts:melotts-zh"]);
	});

	test("引擎黑名单真实改变模型解析:被禁引擎从可用表消失,选择回退首个可用模型", async () => {
		const { enabledSttModels, enabledTtsModels, resolveEnabledSttModel, resolveEnabledTtsModel } = await import(
			"../../src/voice/engine-denylist"
		);
		// 全引擎可用:目录完整,默认 balanced。
		expect(enabledSttModels(settings).map(m => m.key)).toEqual([
			"fast",
			"balanced",
			"turbo",
			"parakeet",
			"sensevoice",
		]);
		expect(resolveEnabledSttModel(undefined, settings).key).toBe("balanced");

		// 禁用 Whisper 一家:三个 Whisper 档位全部消失,SenseVoice 选择不受影响。
		await service.setComponentEnabled({ id: "voice:stt", component: "whisper", enabled: false });
		expect(enabledSttModels(settings).map(m => m.key)).toEqual(["parakeet", "sensevoice"]);
		// 已选 balanced(Whisper)回退到首个可用模型。
		expect(resolveEnabledSttModel("balanced", settings).key).toBe("parakeet");
		expect(resolveEnabledSttModel("sensevoice", settings).key).toBe("sensevoice");

		// 禁用 TTS 中文引擎:目录只剩 Kokoro;中文档选择回退。
		await service.setComponentEnabled({ id: "voice:tts", component: "melotts-zh", enabled: false });
		expect(enabledTtsModels(settings).map(m => m.key)).toEqual(["kokoro"]);
		expect(resolveEnabledTtsModel("melotts-zh", settings).key).toBe("kokoro");

		// 恢复后目录与解析原样回来。
		await service.setComponentEnabled({ id: "voice:stt", component: "whisper", enabled: true });
		await service.setComponentEnabled({ id: "voice:tts", component: "melotts-zh", enabled: true });
		expect(enabledSttModels(settings).map(m => m.key)).toContain("balanced");
		expect(resolveEnabledTtsModel("melotts-zh", settings).key).toBe("melotts-zh");
	});
});

describe("extensions.list 预设启用面(dsh「会话插件」轴)", () => {
	let agentDir: string;
	let tmpCwd: string;
	let modesDir: string;
	let service: ExtensionService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-ext-preset-plane-");
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-preset-plane-cwd-"));
		modesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-preset-plane-modes-"));
		service = new ExtensionService({
			settings: () => Settings.isolated(),
			ensureRegistry: async () => {},
			cwd: () => tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			modesDir: () => modesDir,
			onChanged: () => {},
		});
	});

	test("显式扩展白名单的预设给 extension-module 挂 enabledInPresets;无显式声明的预设不进启用面", async () => {
		// cwd 放一个假扩展模块（空入口会在清单里以加载失败形态出现——
		// 仍是一条 extension-module 条目,身份匹配不受加载成败影响）。
		await fs.mkdir(path.join(tmpCwd, ".musepi", "extensions", "my-ext"), { recursive: true });
		await fs.writeFile(path.join(tmpCwd, ".musepi", "extensions", "my-ext", "index.ts"), "export default {};\n");
		// 显式白名单预设引用它；另一个预设不显式声明 extensions
		// （三态语义：undefined = 全部启用,不构成「按预设提供」）。
		await fs.writeFile(
			path.join(modesDir, "my-preset.json"),
			JSON.stringify({ id: "my-preset", label: "My Preset", extensions: ["my-ext"] }),
		);
		await fs.writeFile(
			path.join(modesDir, "no-explicit.json"),
			JSON.stringify({ id: "no-explicit", label: "No Explicit" }),
		);

		const listed = await service.list();
		const mine = listed.extensions.find(e => e.kind === "extension-module" && e.name === "my-ext");
		expect(mine).toBeDefined();
		expect(mine?.enabledInPresets).toEqual(["My Preset"]);

		// 顶部预设清单只含显式声明者（内置模板会被 ensureModeTemplates
		// 写进临时目录;其中显式声明空白的也进清单,但不挂任何扩展）。
		const plane = listed.presets ?? [];
		expect(plane.some(p => p.id === "my-preset" && p.label === "My Preset")).toBe(true);
		expect(plane.some(p => p.id === "no-explicit")).toBe(false);
	});

	test("白名单不含的扩展不挂 enabledInPresets", async () => {
		await fs.mkdir(path.join(tmpCwd, ".musepi", "extensions", "other-ext"), { recursive: true });
		await fs.writeFile(path.join(tmpCwd, ".musepi", "extensions", "other-ext", "index.ts"), "export default {};\n");
		await fs.writeFile(
			path.join(modesDir, "my-preset.json"),
			JSON.stringify({ id: "my-preset", label: "My Preset", extensions: ["unrelated"] }),
		);

		const listed = await service.list();
		const other = listed.extensions.find(e => e.kind === "extension-module" && e.name === "other-ext");
		expect(other).toBeDefined();
		expect(other?.enabledInPresets).toBeUndefined();
	});
});

describe("extensions.list cordis 运行状态 + 启用条件（收编第一刀）", () => {
	let agentDir: string;
	let tmpCwd: string;
	let modesDir: string;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-ext-runtime-plane-");
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30000);

	beforeEach(async () => {
		tmpCwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-runtime-cwd-"));
		modesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ext-runtime-modes-"));
	});

	const makeService = (
		settings: Settings,
		builtinRuntime?: () => Record<string, { fiberState: string; effects: number }>,
	) =>
		new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => {},
			cwd: () => tmpCwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			modesDir: () => modesDir,
			...(builtinRuntime ? { builtinRuntime } : {}),
			onChanged: () => {},
		});

	test("有 fiber 的镜像单元挂 runtime + activation;operational 跟随镜像设置现读", async () => {
		const settings = Settings.isolated();
		settings.set("stt.enabled", false);
		const service = makeService(settings, () => ({ "voice:stt": { fiberState: "ACTIVE", effects: 0 } }));
		const listed = await service.list();
		const stt = listed.extensions.find(e => e.id === "voice:stt");
		expect(stt?.activation).toEqual({ kind: "setting", key: "stt.enabled" });
		expect(stt?.runtime).toEqual({ fiberState: "ACTIVE", effects: 0, operational: "stopped" });
		expect(stt?.state).toBe("disabled");
	});

	test("镜像键为 on 时 operational=running;无 fiber 的条目与 user 插件不挂 runtime", async () => {
		const settings = Settings.isolated();
		settings.set("stt.enabled", true);
		const service = makeService(settings, () => ({ "voice:stt": { fiberState: "ACTIVE", effects: 0 } }));
		const listed = await service.list();
		const stt = listed.extensions.find(e => e.id === "voice:stt");
		expect(stt?.runtime?.operational).toBe("running");
		// terminal 是 readonly 单元且本例无 fiber → 不挂 runtime（如实缺省）。
		const terminal = listed.extensions.find(e => e.id === "terminal:terminal");
		expect(terminal?.runtime).toBeUndefined();
		expect(terminal?.activation).toBeUndefined();
		// user 插件（假扩展目录）不挂 runtime。
		await fs.mkdir(path.join(tmpCwd, ".musepi", "extensions", "user-ext"), { recursive: true });
		await fs.writeFile(path.join(tmpCwd, ".musepi", "extensions", "user-ext", "index.ts"), "export default {};\n");
		const listed2 = await service.list();
		const user = listed2.extensions.find(e => e.kind === "extension-module" && e.name === "user-ext");
		expect(user?.runtime).toBeUndefined();
	});

	test("builtinRuntime 缺省（宿主未注入 cordis 检视）→ 清单照常,无 runtime 面", async () => {
		const service = makeService(Settings.isolated());
		const listed = await service.list();
		const stt = listed.extensions.find(e => e.id === "voice:stt");
		expect(stt).toBeDefined();
		expect(stt?.runtime).toBeUndefined();
		// activation 不依赖 cordis,镜像单元照常挂。
		expect(stt?.activation).toEqual({ kind: "setting", key: "stt.enabled" });
	});
});
