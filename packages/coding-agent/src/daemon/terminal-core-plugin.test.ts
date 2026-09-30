// ============================================================
// terminal-core builtin 插件单元契约测试（cordis 收编第四刀，设计稿 §2）。
//
// 测试纪律（ADR 边界 3）：全部用真 cordis Context（纯内存、无 IO），不 mock。
// 钉死的契约：
//  1. core 挂载后 ctx 解析 terminal:backends = 插件拥有的注册表同源实例；
//  2. 两个 provider 单元挂载后 bun-pty / node-pty 在册（inject 排序：
//     provider 不先于 core apply）；
//  3. provider fiber dispose = backend 反注册（ctx.effect 账本），core
//     与其余 backend 无损——禁用兜底归因（NO_BACKEND）的数据源；
//  4. 同类型 provider 重复挂载 = 后挂者 fiber FAILED（DUPLICATE_BACKEND
//     层隔离），先挂者与 core 不受影响；
//  5. provider 先于 core 挂载：inject 声明依赖使 fiber pending 至 core
//     provide 后 apply 成功（cordis 依赖排序，而非启动次序巧合）。
// ============================================================

import { describe, expect, it } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import { createTerminalCorePlugin, createTerminalProviderPlugin } from "./terminal-core-plugin";
import type { TerminalRegistry } from "./terminal-registry";

describe("terminal-core builtin 插件单元", () => {
	it("挂载后 ctx 解析 terminal:backends = 插件拥有的注册表同源实例", async () => {
		const ctx = new Context();
		const core = createTerminalCorePlugin();
		await ctx.plugin(core.definition);
		const resolved = ctx.get("terminal:backends", false) as TerminalRegistry | undefined;
		expect(resolved).toBe(core.registry);
		await ctx.fiber.dispose();
	});

	it("两个 provider 单元挂载后 bun-pty / node-pty 在册（inject 依赖排序）", async () => {
		const ctx = new Context();
		const core = createTerminalCorePlugin();
		await ctx.plugin(core.definition);
		await ctx.plugin(createTerminalProviderPlugin("bun-pty"));
		await ctx.plugin(createTerminalProviderPlugin("node-pty"));
		expect(core.registry.listBackends().sort()).toEqual(["bun-pty", "node-pty"]);
		expect(() => core.registry.getBackend("bun-pty")).not.toThrow();
		expect(() => core.registry.getBackend("node-pty")).not.toThrow();
		await ctx.fiber.dispose();
	});

	it("provider fiber dispose = backend 反注册，core 与其余 backend 无损", async () => {
		const ctx = new Context();
		const core = createTerminalCorePlugin();
		await ctx.plugin(core.definition);
		const bun = await ctx.plugin(createTerminalProviderPlugin("bun-pty"));
		const node = await ctx.plugin(createTerminalProviderPlugin("node-pty"));
		await node.dispose();
		// 失败模式 if regressed: effect 账本未挂接——dispose 后 backend 仍在册，
		// 禁用插件的热插拔语义失效（auto 解析不会跳过被禁 backend）。
		expect(core.registry.hasBackend("node-pty")).toBe(false);
		expect(() => core.registry.getBackend("node-pty")).toThrowError(
			expect.objectContaining({ code: "NO_BACKEND" }) as Error,
		);
		expect(core.registry.hasBackend("bun-pty")).toBe(true);
		expect(bun.state).not.toBe(3); // 3 = FAILED（FIBER_STATE 镜像序）
		await ctx.fiber.dispose();
	});

	it("同类型 provider 重复挂载 = 后挂者 FAILED 层隔离，先挂者与 core 无损", async () => {
		const ctx = new Context();
		const core = createTerminalCorePlugin();
		await ctx.plugin(core.definition);
		const first = await ctx.plugin(createTerminalProviderPlugin("bun-pty"));
		// 第二个同类型 provider：apply 内 registerBackend 抛 DUPLICATE_BACKEND。
		let failed = false;
		try {
			await ctx.plugin(createTerminalProviderPlugin("bun-pty"));
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
		expect(core.registry.listBackends()).toEqual(["bun-pty"]);
		// 先挂者仍 ACTIVE（3 = FAILED）。
		expect(first.state).not.toBe(3);
		await ctx.fiber.dispose();
	});

	it("provider 先于 core 挂载：cordis inject 排序——pending 至 core provide 后 apply 成功", async () => {
		const ctx = new Context();
		const core = createTerminalCorePlugin();
		// 先挂 provider（此时 terminal:backends 尚不存在）：fiber 挂起等待依赖。
		const pending = ctx.plugin(createTerminalProviderPlugin("bun-pty"));
		// 失败模式 if regressed: 无 inject 排序时 apply 立即跑、get 拿不到
		// terminal:backends 而 FAILED——backend 永远不注册。
		await ctx.plugin(core.definition);
		await pending;
		expect(core.registry.hasBackend("bun-pty")).toBe(true);
		await ctx.fiber.dispose();
	});
});
