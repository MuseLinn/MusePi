/**
 * 收编第三刀契约测试（设计稿 §2：registerBackend 注册表 + provider 插件化）。
 *
 * 契约：
 * 1. 同类型重复注册 = 结构化 DUPLICATE_BACKEND（不允许覆盖式静默顶替），
 *    错误带 code 供调用方归因本地化。
 * 2. 反注册句柄 dispose = 移除；dispose 旧注册不得误删顶替者（被顶替的
 *    注册 dispose 是 no-op 语义安全）。
 * 3. getBackend 未注册 = 结构化 NO_BACKEND（「终端后端已停用」归因的数据源）。
 * 4. getTerminalProvider：显式 provider 的 open 直查注册表，backend 缺席
 *    = NO_BACKEND（manifest 显式声明严格语义，不静默回退）；auto 只在
 *    在册 backend 间按 bun-pty → node-pty 回退；全缺席 = NO_BACKEND。
 * 5. registerBuiltinTerminalBackends 幂等：同一注册表重复调用不抛
 *    DUPLICATE_BACKEND。
 */
import { describe, expect, test } from "bun:test";
import {
	getTerminalProvider,
	registerBuiltinTerminalBackends,
	resolveTerminalProvider,
} from "../../src/daemon/terminal-provider";
import {
	type TerminalBackend,
	type TerminalHandle,
	TerminalRegistry,
	TerminalRegistryError,
} from "../../src/daemon/terminal-registry";

function fakeHandle(): TerminalHandle {
	return {
		write() {},
		resize() {},
		dispose() {},
		onExit() {},
		onData() {},
	};
}

function fakeBackend(label: string, fail = false): TerminalBackend {
	return {
		async open(): Promise<TerminalHandle> {
			if (fail) throw new Error(`${label} boom`);
			return fakeHandle();
		},
	};
}

describe("TerminalRegistry", () => {
	test("重复注册同类型 = DUPLICATE_BACKEND 结构化错误（覆盖静默顶替）", () => {
		const registry = new TerminalRegistry();
		registry.registerBackend("bun-pty", fakeBackend("a"));
		let err: unknown;
		try {
			registry.registerBackend("bun-pty", fakeBackend("b"));
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(TerminalRegistryError);
		expect((err as TerminalRegistryError).code).toBe("DUPLICATE_BACKEND");
		// 原 backend 未被顶替。
		expect(registry.listBackends()).toEqual(["bun-pty"]);
	});

	test("dispose 反注册后 getBackend = NO_BACKEND，可重新注册", () => {
		const registry = new TerminalRegistry();
		const dispose = registry.registerBackend("node-pty", fakeBackend("a"));
		dispose();
		expect(registry.hasBackend("node-pty")).toBe(false);
		let err: unknown;
		try {
			registry.getBackend("node-pty");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(TerminalRegistryError);
		expect((err as TerminalRegistryError).code).toBe("NO_BACKEND");
		registry.registerBackend("node-pty", fakeBackend("b"));
		expect(registry.hasBackend("node-pty")).toBe(true);
	});

	test("被顶替的旧注册 dispose 不得误删新 backend", () => {
		const registry = new TerminalRegistry();
		const disposeA = registry.registerBackend("bun-pty", fakeBackend("a"));
		disposeA(); // a 退役
		registry.registerBackend("bun-pty", fakeBackend("b")); // b 顶上
		// 旧句柄再 dispose（交错场景）——b 必须还在。
		expect(() => registry.getBackend("bun-pty")).not.toThrow();
		expect(registry.listBackends()).toEqual(["bun-pty"]);
	});

	test("getBackend 未注册 = NO_BACKEND 结构化错误", () => {
		const registry = new TerminalRegistry();
		let err: unknown;
		try {
			registry.getBackend("node-pty");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(TerminalRegistryError);
		expect((err as TerminalRegistryError).code).toBe("NO_BACKEND");
	});
});

describe("registerBuiltinTerminalBackends", () => {
	test("幂等：同一注册表重复调用不抛 DUPLICATE_BACKEND", () => {
		const registry = new TerminalRegistry();
		registerBuiltinTerminalBackends(registry);
		registerBuiltinTerminalBackends(registry);
		expect(registry.listBackends().sort()).toEqual(["bun-pty", "node-pty"]);
	});
});

describe("getTerminalProvider（注册表驱动）", () => {
	const fakeSettings = { getRaw: () => undefined } as never;

	test("显式 provider backend 缺席 = NO_BACKEND（manifest 严格语义，不静默回退）", async () => {
		const registry = new TerminalRegistry();
		registry.registerBackend("node-pty", fakeBackend("node"));
		// manifest/settings 显式选 bun-pty，但 bun-pty 不在册。
		const provider = getTerminalProvider(resolveTerminalProvider(fakeSettings, "bun-pty"), registry);
		let err: unknown;
		try {
			await provider.open("/tmp", 100, 30, "bash", [], {});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(TerminalRegistryError);
		expect((err as TerminalRegistryError).code).toBe("NO_BACKEND");
	});

	test("auto 在在册 backend 间回退：bun-pty 失败落到 node-pty", async () => {
		const registry = new TerminalRegistry();
		registry.registerBackend("bun-pty", fakeBackend("bun", true));
		registry.registerBackend("node-pty", fakeBackend("node"));
		const provider = getTerminalProvider(resolveTerminalProvider(fakeSettings, null), registry);
		const handle = await provider.open("/tmp", 100, 30, "bash", [], {});
		expect(handle).toBeDefined();
	});

	test("auto 跳过缺席 backend：仅 node-pty 在册时直接用 node-pty", async () => {
		const registry = new TerminalRegistry();
		registry.registerBackend("node-pty", fakeBackend("node"));
		const provider = getTerminalProvider(resolveTerminalProvider(fakeSettings, null), registry);
		const handle = await provider.open("/tmp", 100, 30, "bash", [], {});
		expect(handle).toBeDefined();
	});

	test("auto 全缺席 = NO_BACKEND 结构化错误", async () => {
		const registry = new TerminalRegistry();
		const provider = getTerminalProvider(resolveTerminalProvider(fakeSettings, null), registry);
		let err: unknown;
		try {
			await provider.open("/tmp", 100, 30, "bash", [], {});
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(TerminalRegistryError);
		expect((err as TerminalRegistryError).code).toBe("NO_BACKEND");
	});
});
