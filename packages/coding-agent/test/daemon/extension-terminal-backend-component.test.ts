/**
 * 终端 backend 组件通道 · 端到端契约：插件「包含的组件」开关
 * （extensions.setComponentEnabled）经 terminal-backend deny 通道写
 * `terminal.disabledBackends`，名单被 terminal provider 解析链真实消费
 * （auto 回退剔除 + 显式选中结构化 DISABLED_BACKEND）。
 *
 * Why this exists: 组件开关此前只有 tool / stt-engine / tts-engine 三条
 * deny 通道；终端 provider 收编为插件单元（cordis fiber + ctx.effect
 * 账本）后，组件面必须落到真实解析行为上，而不是只改名单的展示层。
 *
 * A regression means: 开关写了别的键（名单漂移）、list 组件状态与名单
 * 不一致、auto 仍使用被禁后端、或显式选中被禁后端静默回退而非结构化报错。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { getTerminalProvider, readDisabledTerminalBackends } from "../../src/daemon/terminal-provider";
import { TerminalRegistry } from "../../src/daemon/terminal-registry";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

const TERMINAL_ID = "terminal:terminal";

/** 永不 resolve 的假 handle（open 被调用到即可判定，不需要真实 pty）。 */
const pendingHandle = {
	write: () => {},
	resize: () => {},
	dispose: () => {},
	onData: () => {},
	onExit: () => {},
};

describe("终端 backend 组件通道（terminal-backend deny）", () => {
	let agentDir: string;
	let settings: Settings;
	let extService: ExtensionService;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("terminal-backend-component-");
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

	it("setComponentEnabled 写 terminal.disabledBackends（不是 voice/tools 名单）", async () => {
		await extService.setComponentEnabled({ id: TERMINAL_ID, component: "bun-pty", enabled: false });
		expect(settings.get("terminal.disabledBackends") as string[]).toContain("bun-pty");
		expect(settings.get("voice.disabledEngines") as string[]).toEqual([]);
		expect(settings.get("tools.disabled") as string[]).toEqual([]);
	});

	it("list 组件面如实下发：被禁组件 enabled=false + canToggle", async () => {
		const { extensions } = await extService.list();
		const terminal = extensions.find(e => e.id === TERMINAL_ID);
		expect(terminal).toBeDefined();
		const byId = new Map(terminal?.components?.map(c => [c.id, c]));
		expect(byId.get("bun-pty")?.enabled).toBe(false);
		expect(byId.get("bun-pty")?.canToggle).toBe(true);
		expect(byId.get("node-pty")?.enabled).toBe(true);
	});

	it("重新启用：名单移除、list 恢复 enabled", async () => {
		await extService.setComponentEnabled({ id: TERMINAL_ID, component: "bun-pty", enabled: true });
		expect(settings.get("terminal.disabledBackends") as string[]).toEqual([]);
		const { extensions } = await extService.list();
		const terminal = extensions.find(e => e.id === TERMINAL_ID);
		expect(terminal?.components?.find(c => c.id === "bun-pty")?.enabled).toBe(true);
	});

	it("未声明组件（如把 auto 当组件）：结构化拒绝且名单不落盘", async () => {
		const before = [...(settings.get("terminal.disabledBackends") as string[])];
		const error = await extService
			.setComponentEnabled({ id: TERMINAL_ID, component: "auto", enabled: false })
			.catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("auto");
		expect(settings.get("terminal.disabledBackends") as string[]).toEqual(before);
	});
});

describe("terminal provider 解析消费 disabledBackends", () => {
	function registryWithBoth(): TerminalRegistry {
		const registry = new TerminalRegistry();
		registry.registerBackend("bun-pty", { open: () => Promise.resolve(pendingHandle as never) });
		registry.registerBackend("node-pty", { open: () => Promise.resolve(pendingHandle as never) });
		return registry;
	}

	it("readDisabledTerminalBackends：坏值/非数组 fail-soft 为空集", () => {
		expect(readDisabledTerminalBackends({ get: () => "nope" }).size).toBe(0);
		expect(readDisabledTerminalBackends({ get: () => ["bun-pty"] }).has("bun-pty")).toBe(true);
	});

	it("auto：被禁后端从回退顺序剔除，直用剩余后端", async () => {
		const registry = new TerminalRegistry();
		let bunPtyCalls = 0;
		let nodePtyCalls = 0;
		registry.registerBackend("bun-pty", {
			open: () => {
				bunPtyCalls++;
				return Promise.resolve(pendingHandle as never);
			},
		});
		registry.registerBackend("node-pty", {
			open: () => {
				nodePtyCalls++;
				return Promise.resolve(pendingHandle as never);
			},
		});
		const provider = getTerminalProvider("auto", registry, new Set(["bun-pty"]));
		await provider.open(".", 80, 24, "sh", [], {});
		// 被禁后端根本没被尝试（不是「试过再失败回退」）。
		expect(bunPtyCalls).toBe(0);
		expect(nodePtyCalls).toBe(1);
	});

	it("auto：全部后端被禁 = 结构化 NO_BACKEND（不是静默成功）", async () => {
		const registry = registryWithBoth();
		const provider = getTerminalProvider("auto", registry, new Set(["bun-pty", "node-pty"]));
		const error = await provider.open(".", 80, 24, "sh", [], {}).catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain("no terminal backend available");
	});

	it("显式选中被禁后端 = 结构化 DISABLED_BACKEND（用户显式意图不静默回退）", async () => {
		const registry = registryWithBoth();
		const provider = getTerminalProvider("node-pty", registry, new Set(["node-pty"]));
		const error = await provider.open(".", 80, 24, "sh", [], {}).catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect(String((error as Error).message)).toContain('terminal backend "node-pty" is disabled');
	});
});
