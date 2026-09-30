// ============================================================
// terminal-core builtin 插件单元 —— cordis 收编第四刀（设计稿 §2
// 目标形态：终端能力收进 builtin 插件，dsh
// packages/terminal/terminal + tool-terminal 形状 parity，不拷 dsh 代码）。
//
// 能力缝声明（M2-2.4）：
// - 名称+ns：terminal-core（daemon 装配面，builtin 信任级）；provider
//   子单元 terminal-provider-bunpty / terminal-provider-nodepty。
// - 输入：terminal:deps（宿主能力注入：envelope seq / 连接 emit /
//   settings，宿主保留——与 DaemonServer 共享编号空间是既有契约）；
//   cordis 根 Context（terminal-core 先于 provider 单元 provide
//   terminal:backends，provider 经 inject 声明依赖，cordis 排序）。
// - 输出：terminal:backends（TerminalRegistry 同源实例——pty 进程持有、
//   backend 注册表、owner 鉴权、输出路由的真实数据源）；backend 注册/
//   反注册挂 ctx.effect 账本（fiber 拆卸 = 反注册，禁用兜底归因
//   （设计稿 §3.③）由此获得真实数据源：NO_BACKEND 结构化码 →
//   「终端后端已停用，原因：插件被禁用」）。
// - 生命周期：双跑期（external）注册表由工厂急构造、宿主注入
//   TerminalService 同一实例——fiber dispose 不销毁注册表（回滚后 P1
//   路径不受影响）；backend 注册的挂/拔已走 cordis effect 账本
//   （provider 单元 dispose = 反注册）。进程退出随 daemon 消亡。
// - 启停：随 daemon 进程创建/消亡；无独立启停（builtin 试点期只读
//   不可禁用，禁用兜底主要保护 user provider 插件场景）。
// - 冲突：同类型 backend 重复注册 = DUPLICATE_BACKEND（registry 内
//   结构化错误 → provider 单元 fiber FAILED，层隔离不拖垮 core）。
// ============================================================

import type { Plugin } from "@deepseek-ai/cordis";
import { createBunPtyBackend, createNodePtyBackend } from "./terminal-provider.ts";
import { type TerminalBackendType, TerminalRegistry } from "./terminal-registry.ts";

/** terminal-core 插件句柄：definition 挂进宿主 cordis 根 Context，
 *  registry 是插件拥有的注册表实例（宿主 RPC 薄层注入 TerminalService
 *  同一实例——双跑期 external 生命周期，构造权威仍在宿主）。 */
export interface TerminalCorePluginHandle {
	definition: Plugin.Object;
	registry: TerminalRegistry;
}

/** 构造 terminal-core 插件单元：apply provide terminal:backends（插件
 *  拥有的注册表）。 */
export function createTerminalCorePlugin(): TerminalCorePluginHandle {
	const registry = new TerminalRegistry();
	return {
		registry,
		definition: {
			name: "terminal-core",
			apply: ctx => {
				ctx.provide("terminal:backends", registry);
			},
		},
	};
}

const PROVIDER_PLUGIN_NAMES: Record<TerminalBackendType, string> = {
	"bun-pty": "terminal-provider-bunpty",
	"node-pty": "terminal-provider-nodepty",
};

/** 构造一个 builtin provider 插件单元：inject terminal:backends，
 *  apply 时 registerBackend 挂 ctx.effect 账本——fiber dispose 即反注册
 *  （backend 缺席 = NO_BACKEND 结构化归因）。core 未挂载时 apply 抛错，
 *  fiber FAILED 层隔离，不拖垮宿主与其余单元。 */
export function createTerminalProviderPlugin(type: TerminalBackendType): Plugin.Object {
	return {
		name: PROVIDER_PLUGIN_NAMES[type],
		inject: ["terminal:backends"],
		apply: ctx => {
			const registry = ctx.get("terminal:backends", false) as TerminalRegistry | undefined;
			if (!registry) {
				throw new Error(
					`${PROVIDER_PLUGIN_NAMES[type]}: terminal:backends not provided — terminal-core must mount first`,
				);
			}
			const backend = type === "bun-pty" ? createBunPtyBackend() : createNodePtyBackend();
			const dispose = registry.registerBackend(type, backend);
			ctx.effect(() => dispose, `terminal-backend:${type}`);
		},
	};
}
