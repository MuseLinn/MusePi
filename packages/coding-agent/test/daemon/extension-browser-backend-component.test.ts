/**
 * 浏览器 backend 组件通道 · 端到端契约：插件「包含的组件」开关
 * （extensions.setComponentEnabled）经 browser-backend deny 通道写
 * `browser.disabledBackends`，名单被 browser 工具解析链真实消费
 * （设置链回退跳过被禁环节 + 显式 app 参数结构化 DISABLED_BACKEND +
 * 全禁 NO_BACKEND）。
 *
 * Why this exists: browser 行原先只有一个 tool-deny 的整工具组件，粒度
 * 与 terminal 刀的 provider 组件不对齐；browser 子系统的真实可启停单位
 * 是三个后端（launch = 脚本启动 / attach = 接管已有浏览器 / gui = 托管
 * 面板桥），组件面必须落到真实解析行为上，而不是只改名单的展示层。
 *
 * A regression means: 开关写了别的键（名单漂移）、list 组件状态与名单
 * 不一致、设置链仍使用被禁后端、显式指向被禁后端静默回退而非结构化报错、
 * 或全禁时静默成功而非 NO_BACKEND。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { BUILTIN_EXTENSIONS } from "../../src/extensibility/extensions-center/builtin-registry";
import { readDisabledBrowserBackends, resolveBrowserKind } from "../../src/tools/browser";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const BROWSER_ID = "browser:browser";

/** ToolSession 的最小形状：resolveBrowserKind 只读 settings 与 cwd。 */
function sessionWith(settings: Settings): Parameters<typeof resolveBrowserKind>[1] {
	return { settings, cwd: process.cwd() } as Parameters<typeof resolveBrowserKind>[1];
}

describe("浏览器 backend 组件通道（browser-backend deny）", () => {
	let agentDir: string;
	let settings: Settings;
	let extService: ExtensionService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("browser-backend-component-");
		settings = Settings.isolated();
		extService = new ExtensionService({
			settings: () => settings,
			ensureRegistry: async () => ({}),
			cwd: () => process.cwd(),
			webUrl: () => null,
			webPortFile: () => "",
			dynamicRuntime: () => Promise.resolve(undefined),
			onChanged: () => {},
		});
	}, 30_000);

	afterAll(async () => {
		await restoreAgentDirForTest(agentDir);
	}, 30_000);

	it("注册表投影契约：browser 行组件 = launch/attach/gui × browser-backend", () => {
		const browser = BUILTIN_EXTENSIONS.find(d => d.kind === "browser" && d.name === "browser");
		expect(browser?.settingsMirror?.key).toBe("browser.enabled");
		expect(browser?.components?.map(c => [c.id, c.deny])).toEqual([
			["launch", "browser-backend"],
			["attach", "browser-backend"],
			["gui", "browser-backend"],
		]);
		// computer 行保持 tool-deny 单组件（包形态已就位，第四刀不改动）。
		const computer = BUILTIN_EXTENSIONS.find(d => d.kind === "computer" && d.name === "computer");
		expect(computer?.settingsMirror).toEqual({
			key: "computer.enabled",
			on: true,
			off: false,
			unsetDisabled: true,
		});
		expect(computer?.components?.map(c => [c.id, c.deny])).toEqual([["computer", "tool"]]);
	});

	it("setComponentEnabled 写 browser.disabledBackends（不是 voice/tools/terminal 名单）", async () => {
		await extService.setComponentEnabled({ id: BROWSER_ID, component: "launch", enabled: false });
		expect(settings.get("browser.disabledBackends") as string[]).toContain("launch");
		expect(settings.get("voice.disabledEngines") as string[]).toEqual([]);
		expect(settings.get("tools.disabled") as string[]).toEqual([]);
		expect(settings.get("terminal.disabledBackends") as string[]).toEqual([]);
	});

	it("list 组件面如实下发：被禁组件 enabled=false + canToggle", async () => {
		const { extensions } = await extService.list();
		const browser = extensions.find(e => e.id === BROWSER_ID);
		expect(browser).toBeDefined();
		const byId = new Map(browser?.components?.map(c => [c.id, c]));
		expect(byId.get("launch")?.enabled).toBe(false);
		expect(byId.get("launch")?.canToggle).toBe(true);
		expect(byId.get("attach")?.enabled).toBe(true);
		expect(byId.get("gui")?.enabled).toBe(true);
	});

	it("重新启用：名单移除、list 恢复 enabled", async () => {
		await extService.setComponentEnabled({ id: BROWSER_ID, component: "launch", enabled: true });
		expect(settings.get("browser.disabledBackends") as string[]).toEqual([]);
		const { extensions } = await extService.list();
		const browser = extensions.find(e => e.id === BROWSER_ID);
		expect(browser?.components?.find(c => c.id === "launch")?.enabled).toBe(true);
	});

	it("未声明组件（如旧的整工具 id browser）：结构化拒绝且名单不落盘", async () => {
		const before = [...(settings.get("browser.disabledBackends") as string[])];
		const error = await extService
			.setComponentEnabled({ id: BROWSER_ID, component: "browser", enabled: false })
			.catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("browser");
		expect(settings.get("browser.disabledBackends") as string[]).toEqual(before);
	});
});

describe("resolveBrowserKind 消费 disabledBackends", () => {
	it("readDisabledBrowserBackends：坏值/非数组 fail-soft 为空集", () => {
		expect(readDisabledBrowserBackends({ get: () => "nope" }).size).toBe(0);
		expect(readDisabledBrowserBackends({ get: () => ["gui"] }).has("gui")).toBe(true);
	});

	it("默认无禁：空参数解析到 headless 兜底", () => {
		const settings = Settings.isolated();
		expect(resolveBrowserKind({ action: "open" }, sessionWith(settings)).kind).toBe("headless");
	});

	it("设置链回退：attach 被禁时跳过 cdpUrl 落到 headless（不尝试被禁后端）", () => {
		const settings = Settings.isolated();
		settings.set("browser.cdpUrl", "http://127.0.0.1:9222");
		settings.set("browser.disabledBackends", ["attach"]);
		const kind = resolveBrowserKind({ action: "open" }, sessionWith(settings));
		expect(kind.kind).toBe("headless");
	});

	it("gui 被禁：browser.gui=true 也跳过托管桥，落到 headless", () => {
		const settings = Settings.isolated();
		settings.set("browser.gui", true);
		settings.set("browser.guiUrl", "http://127.0.0.1:9230");
		settings.set("browser.disabledBackends", ["gui"]);
		const kind = resolveBrowserKind({ action: "open" }, sessionWith(settings));
		expect(kind.kind).toBe("headless");
	});

	it("对照：gui 启用时 browser.gui=true 解析到 connected(gui:true)", () => {
		const settings = Settings.isolated();
		settings.set("browser.gui", true);
		settings.set("browser.guiUrl", "http://127.0.0.1:9230");
		const kind = resolveBrowserKind({ action: "open" }, sessionWith(settings));
		expect(kind).toEqual({ kind: "connected", cdpUrl: "http://127.0.0.1:9230", gui: true });
	});

	it("全禁 = 结构化 NO_BACKEND（code 上下文，不是静默成功）", () => {
		const settings = Settings.isolated();
		settings.set("browser.disabledBackends", ["launch", "attach", "gui"]);
		const error = (() => {
			try {
				resolveBrowserKind({ action: "open" }, sessionWith(settings));
			} catch (err) {
				return err;
			}
		})();
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain("no browser backend available");
	});

	it("显式 app.path 指向被禁 attach = 结构化 DISABLED_BACKEND（不静默回退）", () => {
		const settings = Settings.isolated();
		settings.set("browser.disabledBackends", ["attach"]);
		const error = (() => {
			try {
				resolveBrowserKind({ action: "open", app: { path: "/usr/bin/chromium" } }, sessionWith(settings));
			} catch (err) {
				return err;
			}
		})();
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain('browser backend "attach" is disabled');
	});

	it("显式 app.cdp_url 指向被禁 attach = 结构化 DISABLED_BACKEND", () => {
		const settings = Settings.isolated();
		settings.set("browser.disabledBackends", ["attach"]);
		const error = (() => {
			try {
				resolveBrowserKind({ action: "open", app: { cdp_url: "http://127.0.0.1:9222" } }, sessionWith(settings));
			} catch (err) {
				return err;
			}
		})();
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain('browser backend "attach" is disabled');
	});

	it("显式 app.relay=true 指向被禁 attach = 结构化 DISABLED_BACKEND", () => {
		const settings = Settings.isolated();
		settings.set("browser.disabledBackends", ["attach"]);
		const error = (() => {
			try {
				resolveBrowserKind({ action: "open", app: { relay: true } }, sessionWith(settings));
			} catch (err) {
				return err;
			}
		})();
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain('browser backend "attach" is disabled');
	});
});
