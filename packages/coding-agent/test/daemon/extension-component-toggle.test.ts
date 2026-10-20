/**
 * 组件对齐刀 · 接线契约：extensions.setComponentEnabled 的 user 插件径
 * （extension-module 条目清单 `musepi.components` 声明的 entry 组件）与
 * extensions.list 的组件 runtime 面下发。
 *
 * Why this exists: 组件开关从「builtin deny 软开关」扩展到「user 插件
 * entry 组件 = fiber 子插件」后,回归路径：
 *  - RPC 只写黑名单不触 fiber → 禁用后组件命令实际仍可调用（展示层开关）；
 *  - 运行时尚未 reconcile（插件未装载）时开关直接抛错而不是先装载再切换；
 *  - list 组件面不带 fiber 运行态 → GUI 详情弹窗组件行无真实状态可显示。
 *
 * A regression means: the toggle lies (command still callable), the first
 * toggle fails on a freshly started daemon, or the list plane loses the
 * per-component fiber truth.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { getProjectAgentDir } from "@musepi/pi-utils";
import { CordisDynamicPluginRuntime } from "../../src/daemon/cordis-dynamic-plugins";
import { DaemonHostContext } from "../../src/daemon/host-context";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const PLUGIN = "svc-comps";
/** 第二个 describe 的插件名必须与第一个不同：两个 suite 的项目目录各自
 *  独立，但 `disabledExtensions` / 组件黑名单写在同一个 Settings 实例里，
 *  同名条目会让一个 suite 的写入命中另一个 suite 的扫描行。 */
const PKG_PLUGIN = "svc-comps-pkg";

describe("extensions.setComponentEnabled user 插件径（组件对齐刀接线）", () => {
	let agentDir: string;
	let projectDir: string;
	let host: DaemonHostContext;
	let dynamic: CordisDynamicPluginRuntime;
	let extService: ExtensionService;
	let settings: Settings;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("component-toggle-");
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "component-toggle-proj-"));
		const pluginDir = path.join(getProjectAgentDir(projectDir), "extensions", PLUGIN);
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: PLUGIN,
				version: "0.0.0",
				musepi: {
					extensions: ["./index.ts"],
					components: [
						{ id: "alpha", description: "Alpha unit", entry: "./alpha.ts" },
						{ id: "beta", entry: "./beta.ts" },
					],
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "index.ts"),
			`export default function (pi) { pi.registerCommand("${PLUGIN}-main", { handler: async () => "main" }); }\n`,
		);
		fs.writeFileSync(
			path.join(pluginDir, "alpha.ts"),
			`export default function (pi) { pi.registerCommand("${PLUGIN}-alpha", { handler: async () => "alpha" }); }\n`,
		);
		fs.writeFileSync(
			path.join(pluginDir, "beta.ts"),
			`export default function (pi) { pi.registerCommand("${PLUGIN}-beta", { handler: async () => "beta" }); }\n`,
		);
		host = new DaemonHostContext();
		dynamic = new CordisDynamicPluginRuntime(host);
		settings = Settings.isolated();
		extService = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => projectDir,
			webUrl: () => null,
			webPortFile: () => path.join(projectDir, "web.port"),
			dynamicRuntime: () => Promise.resolve(dynamic),
			onChanged: () => {},
		});
	}, 30_000);

	afterAll(async () => {
		await dynamic.dispose();
		await host.dispose();
		fs.rmSync(projectDir, { recursive: true, force: true });
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("首次开关（运行时尚未 reconcile）：先装载再切换,黑名单持久化且 fiber 真实停用", async () => {
		await extService.setComponentEnabled({ id: `extension-module:${PLUGIN}`, component: "alpha", enabled: false });

		// 黑名单落盘（复合键 <plugin>/<component>）。
		const denylist = settings.get("disabledExtensionComponents") as string[];
		expect(denylist).toContain(`${PLUGIN}/alpha`);

		// fiber 真实停用：宿主命令面缺席（不是展示层）。
		const record = dynamic.inspect().find(r => r.name === PLUGIN);
		expect(record?.status).toBe("active");
		expect(record?.components.find(c => c.id === "alpha")?.status).toBe("disabled");
		expect(record?.components.find(c => c.id === "beta")?.status).toBe("active");
	});

	it("list 组件面：enabled/canToggle/disabledReason + 组件级 fiber runtime 如实下发", async () => {
		const { extensions } = await extService.list();
		const entry = extensions.find(e => e.id === PLUGIN);
		expect(entry).toBeDefined();
		const byId = new Map(entry?.components?.map(c => [c.id, c]));
		expect(byId.get("alpha")?.enabled).toBe(false);
		expect(byId.get("alpha")?.canToggle).toBe(true);
		expect(byId.get("alpha")?.disabledReason).toBe("component-disabled");
		expect(byId.get("beta")?.enabled).toBe(true);
		expect(byId.get("beta")?.runtime?.fiberState).toBe("ACTIVE");
		expect(byId.get("beta")?.runtime?.effects).toBeGreaterThan(0);
	});

	it("重新启用：黑名单移除、组件 fiber 重挂、命令面恢复", async () => {
		await extService.setComponentEnabled({ id: `extension-module:${PLUGIN}`, component: "alpha", enabled: true });
		expect(settings.get("disabledExtensionComponents") as string[]).not.toContain(`${PLUGIN}/alpha`);
		expect(
			dynamic
				.inspect()
				.find(r => r.name === PLUGIN)
				?.components.find(c => c.id === "alpha")?.status,
		).toBe("active");
	});

	it("未声明组件：结构化拒绝且黑名单不落盘", async () => {
		const before = [...(settings.get("disabledExtensionComponents") as string[])];
		const error = await extService
			.setComponentEnabled({ id: `extension-module:${PLUGIN}`, component: "nope", enabled: false })
			.catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("nope");
		expect(settings.get("disabledExtensionComponents") as string[]).toEqual(before);
	});
});

describe("plugins.setEnabled 的组件联动（包开关 = 总闸）", () => {
	let agentDir: string;
	let projectDir: string;
	let host: DaemonHostContext;
	let dynamic: CordisDynamicPluginRuntime;
	let extService: ExtensionService;
	let settings: Settings;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("package-toggle-");
		projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "package-toggle-proj-"));
		const pluginDir = path.join(getProjectAgentDir(projectDir), "extensions", PKG_PLUGIN);
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: PKG_PLUGIN,
				version: "0.0.0",
				musepi: {
					extensions: ["./index.ts"],
					components: [
						{ id: "alpha", description: "Alpha unit", entry: "./alpha.ts" },
						{ id: "beta", entry: "./beta.ts" },
					],
				},
			}),
		);
		fs.writeFileSync(
			path.join(pluginDir, "index.ts"),
			`export default function (pi) { pi.registerCommand("${PKG_PLUGIN}-main", { handler: async () => "main" }); }\n`,
		);
		fs.writeFileSync(
			path.join(pluginDir, "alpha.ts"),
			`export default function (pi) { pi.registerCommand("${PKG_PLUGIN}-alpha", { handler: async () => "alpha" }); }\n`,
		);
		fs.writeFileSync(
			path.join(pluginDir, "beta.ts"),
			`export default function (pi) { pi.registerCommand("${PKG_PLUGIN}-beta", { handler: async () => "beta" }); }\n`,
		);
		host = new DaemonHostContext();
		dynamic = new CordisDynamicPluginRuntime(host);
		settings = Settings.isolated();
		extService = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => projectDir,
			webUrl: () => null,
			webPortFile: () => path.join(projectDir, "web.port"),
			dynamicRuntime: () => Promise.resolve(dynamic),
			onChanged: () => {},
		});
	}, 30_000);

	afterAll(async () => {
		await dynamic.dispose();
		await host.dispose();
		fs.rmSync(projectDir, { recursive: true, force: true });
		// Settings.isolated() is a process-level singleton: the two deny keys
		// this suite writes would leak into every later file in the same
		// `bun test` process (a sibling suite's scan then reads our plugin as
		// disabled). Clear them so the suite leaves no trace.
		settings.set("disabledExtensions" as Parameters<Settings["set"]>[0], [] as never);
		settings.set("disabledExtensionComponents" as Parameters<Settings["set"]>[0], [] as never);
		await settings.flush();
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("停用：条目 id 与组件黑名单同步落盘，fiber 卸载，但组件声明仍可检视", async () => {
		// 先装载（首次 reconcile），否则 unload 无从谈起。
		await extService.getExtensionRuntimeLoad();
		const loaded = dynamic.inspect().find(r => r.name === PKG_PLUGIN);
		expect(loaded?.status).toBe("active");
		expect(loaded?.components.map(c => c.id).sort()).toEqual(["alpha", "beta"]);

		await extService.setPluginEnabled({ name: PKG_PLUGIN, enabled: false });

		// 1) 两套存储同步：条目 id 进 disabledExtensions，组件键进黑名单。
		expect(settings.get("disabledExtensions") as string[]).toContain(PKG_PLUGIN);
		const denylist = settings.get("disabledExtensionComponents") as string[];
		expect(denylist).toContain(`${PKG_PLUGIN}/alpha`);
		expect(denylist).toContain(`${PKG_PLUGIN}/beta`);

		// 2) fiber 真卸载：宿主命令面缺席（不是展示层）。
		const unloaded = dynamic.inspect().find(r => r.name === PKG_PLUGIN);
		expect(unloaded?.status).toBe("unloaded");

		// 3) 组件声明仍在检视面——包开关是安装/卸载语义，管理界面必须继续
		//    列出插件声明了什么（行读真实未挂载态），否则组件段随开关消失，
		//    用户无从知道停用期间关掉了什么。
		expect(unloaded?.components.map(c => c.id).sort()).toEqual(["alpha", "beta"]);
		expect(unloaded?.components.every(c => c.status === "unloaded")).toBe(true);

		// 4) list 组件面同样不消失（enabled=false 如实标，canToggle 保持）。
		const { extensions } = await extService.list();
		const entry = extensions.find(e => e.id === PKG_PLUGIN);
		expect(entry?.state).toBe("disabled");
		expect(entry?.components?.map(c => c.id).sort()).toEqual(["alpha", "beta"]);
		expect(entry?.components?.every(c => c.enabled === false)).toBe(true);
		expect(entry?.components?.every(c => c.canToggle === true)).toBe(true);
	});

	it("重新启用：条目 id 与黑名单摘除，组件 fiber 重挂", async () => {
		await extService.setPluginEnabled({ name: PKG_PLUGIN, enabled: true });
		expect(settings.get("disabledExtensions") as string[]).not.toContain(PKG_PLUGIN);
		expect(settings.get("disabledExtensionComponents") as string[]).not.toContain(`${PKG_PLUGIN}/alpha`);

		const record = dynamic.inspect().find(r => r.name === PKG_PLUGIN);
		expect(record?.status).toBe("active");
		expect(record?.components.find(c => c.id === "alpha")?.status).toBe("active");
		expect(record?.components.find(c => c.id === "beta")?.status).toBe("active");
	});
});
