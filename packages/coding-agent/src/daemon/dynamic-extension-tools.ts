/**
 * P2 动态自举工具链(DSH cordis-host-runner 的 musepi 落地,无审批):
 *
 * 会话内 agent 定义→运行→停用→删除动态插件工具,全程沙箱隔离:
 * - ext_define  { name, purpose, hostCode, pluginId? }
 *     定义不可变 package(pluginId 省略 = 新插件)。host 代码语法预检。
 * - ext_run     { pluginId, packageId? }
 *     激活版本(packageId 省略 = 最新):vm 沙箱执行 host 半体 → defineTool
 *     注册工具 → 写入会话工具链(extdyn__ 命名空间,立即对模型可见)。
 * - ext_stop    { pluginId }     停用:移除该插件全部动态工具。
 * - ext_undefine{ pluginId }     删除插件(含活动 run 与全部版本)。
 * - ext_inspect { pluginId? }    注册表快照(含每工具状态)。
 *
 * 工具名命名空间 `extdyn__<name>`(MCP `mcp__` 同款约定),避免与内置
 * 工具冲突;同一会话内工具全量 reconcile —— 会话间注册表独立。
 */

import { type } from "@musepi/omptype";
import type { AgentToolResult, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import type { AgentSession } from "../session/agent-session";
import { createSandbox, evaluateHostCode, precheckCode, type SandboxToolDefinition } from "./extension-sandbox";

/** 动态工具注册名前缀(与 isMCPToolName 同族约定)。 */
export const DYNAMIC_TOOL_PREFIX = "extdyn__";

const VM_TIMEOUT_MS = 5_000;

export interface DynamicPackageVersion {
	packageId: string;
	hostCode: string;
	createdAt: number;
}

export interface DynamicPluginRun {
	packageId: string;
	/** 活动动态工具(注册名 = extdyn__name;全量 reconcile 用)。 */
	customTools: CustomTool[];
	startedAt: number;
}

export interface DynamicPlugin {
	pluginId: string;
	sessionId: string;
	name: string;
	purpose: string;
	packages: Map<string, DynamicPackageVersion>;
	activeRun?: DynamicPluginRun;
}

export interface DynamicPluginSnapshot {
	pluginId: string;
	name: string;
	purpose: string;
	packageCount: number;
	activePackageId?: string;
	activeToolNames: string[];
}

/** 会话级动态插件注册表(进程内存;不可变版本 + 单活动 run)。 */
export class DynamicToolRegistry {
	readonly #plugins = new Map<string, DynamicPlugin>();
	#pluginSeq = 0;
	#packageSeq = 0;

	mintPluginId(prefix: string): string {
		return `${prefix}${String(++this.#pluginSeq).padStart(3, "0")}`;
	}

	mintPackageId(): string {
		return `pkg${String(++this.#packageSeq).padStart(3, "0")}`;
	}

	get(pluginId: string): DynamicPlugin | undefined {
		return this.#plugins.get(pluginId);
	}

	all(): DynamicPluginSnapshot[] {
		const out: DynamicPluginSnapshot[] = [];
		for (const plugin of this.#plugins.values()) {
			out.push(this.#snapshot(plugin));
		}
		return out;
	}

	/** 全部活动工具(跨插件,会话工具链全量 reconcile 用)。 */
	allActiveCustomTools(): CustomTool[] {
		const out: CustomTool[] = [];
		for (const plugin of this.#plugins.values()) {
			if (plugin.activeRun) out.push(...plugin.activeRun.customTools);
		}
		return out;
	}

	#snapshot(plugin: DynamicPlugin): DynamicPluginSnapshot {
		return {
			pluginId: plugin.pluginId,
			name: plugin.name,
			purpose: plugin.purpose,
			packageCount: plugin.packages.size,
			activePackageId: plugin.activeRun?.packageId,
			activeToolNames: plugin.activeRun?.customTools.map(t => t.name) ?? [],
		};
	}

	put(plugin: DynamicPlugin): void {
		this.#plugins.set(plugin.pluginId, plugin);
	}

	delete(pluginId: string): DynamicPlugin | undefined {
		const plugin = this.#plugins.get(pluginId);
		this.#plugins.delete(pluginId);
		return plugin;
	}
}

interface DefineParams {
	name: string;
	purpose: string;
	hostCode: string;
	pluginId?: string;
}

interface RunParams {
	pluginId: string;
	packageId?: string;
}

interface SimpleParams {
	pluginId: string;
}

export type LiveSessionLookup = (sessionId: string) => { agentSession: AgentSession } | undefined;

/**
 * 创建动态插件工具链。`sessionOf(ctx)` 与 extension-manager-tools 同款
 * (会话查表由 DaemonSessionHost 注入),每个会话持有独立 registry。
 */
export function createDynamicExtensionTools(
	sessionOf: (ctx: CustomToolContext) => AgentSession | null,
	registryFor: (ctx: CustomToolContext) => DynamicToolRegistry,
): Array<CustomTool<any, any>> {
	const defineSchema = type({
		name: type("string").describe("插件名(非空)"),
		purpose: type("string").describe("插件用途(非空,一行说明)"),
		hostCode: type("string").describe(
			"host 半体代码:async 函数体,调用注入的 defineTool({name,description,parameters,run})",
		),
		pluginId: type("string").describe("省略 = 新建插件;提供 = 追加不可变版本").optional(),
	});
	const runSchema = type({
		pluginId: type("string").describe("插件 id(ext_define 返回值)"),
		packageId: type("string").describe("省略 = 激活最新版本").optional(),
	});
	const simpleSchema = type({
		pluginId: type("string").describe("插件 id"),
	});
	const inspectSchema = type({
		pluginId: type("string").describe("省略 = 全部插件").optional(),
	});

	const textResult = (text: string): { content: Array<{ type: "text"; text: string }> } => ({
		content: [{ type: "text", text }],
	});

	const defineTool: CustomTool<typeof defineSchema> = {
		name: "ext_define",
		label: "定义动态插件",
		description:
			"定义动态插件(不可变版本):语法预检通过后存入会话注册表。hostCode 是 async 函数体,可调用注入的 defineTool({name,description,parameters,run}) 声明工具。返回 pluginId/packageId。",
		parameters: defineSchema,
		async execute(
			_toolCallId: string,
			params: typeof defineSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof defineSchema.infer>> {
			const session = sessionOf(ctx);
			if (!session) return textResult('{"ok":false,"error":"no live session"}');
			const p = params as DefineParams;
			const name = p.name.trim();
			const purpose = p.purpose.trim();
			if (name.length === 0) return textResult('{"ok":false,"error":"ext_define needs a non-empty name"}');
			if (purpose.length === 0) return textResult('{"ok":false,"error":"ext_define needs a non-empty purpose"}');
			if (p.hostCode.length === 0) return textResult('{"ok":false,"error":"ext_define needs non-empty hostCode"}');
			try {
				precheckCode(p.hostCode, "hostCode");
			} catch (error) {
				return textResult(JSON.stringify({ ok: false, error: String(error) }));
			}
			const registry = registryFor(ctx);
			const pluginId = p.pluginId?.trim() || undefined;
			let plugin = pluginId ? registry.get(pluginId) : undefined;
			if (pluginId && !plugin) {
				return textResult(`{"ok":false,"error":"plugin ${pluginId} does not exist"}`);
			}
			if (!plugin) {
				const minted = registry.mintPluginId("dyn");
				plugin = {
					pluginId: minted,
					sessionId: ctx.sessionManager.getSessionId(),
					name,
					purpose,
					packages: new Map(),
				};
				registry.put(plugin);
			}
			const packageId = registry.mintPackageId();
			plugin.packages.set(packageId, { packageId, hostCode: p.hostCode, createdAt: Date.now() });
			return textResult(
				JSON.stringify({
					ok: true,
					pluginId: plugin.pluginId,
					packageId,
					name: plugin.name,
					purpose: plugin.purpose,
				}),
			);
		},
	};

	const runTool: CustomTool<typeof runSchema> = {
		name: "ext_run",
		label: "运行动态插件",
		description:
			"激活插件版本:vm 沙箱执行 host 半体,defineTool 声明的工具注册进会话工具链(extdyn__ 前缀),下个模型调用即可用。同一插件重新运行 = 热更新版本。",
		parameters: runSchema,
		async execute(
			_toolCallId: string,
			params: typeof runSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof runSchema.infer>> {
			const session = sessionOf(ctx);
			if (!session) return textResult('{"ok":false,"error":"no live session"}');
			const p = params as RunParams;
			const registry = registryFor(ctx);
			const plugin = registry.get(p.pluginId);
			if (!plugin) return textResult(`{"ok":false,"error":"plugin ${p.pluginId} does not exist"}`);
			const packageId = p.packageId ?? [...plugin.packages.keys()].sort().at(-1);
			const version = packageId ? plugin.packages.get(packageId) : undefined;
			if (!version) {
				return textResult(`{"ok":false,"error":"package ${p.packageId ?? "(latest)"} not found"}`);
			}
			// 沙箱执行:闭包捕获宿主数组(不依赖 vm context 属性回流)。
			const tools: SandboxToolDefinition[] = [];
			const sandbox = createSandbox(plugin.pluginId, {
				defineTool: def => tools.push(def),
				log: (...args: unknown[]) =>
					ctx.sessionManager.getCwd() && console.log(`[dyn:${plugin.pluginId}]`, ...args),
				setTimeout: (fn, ms) => setTimeout(fn, ms),
				clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
			});
			try {
				// shape A:hostCode 是 async 函数体(DSH evaluateHostCode 语义,
				// 包成 `(async () => { code })` 执行)。
				await evaluateHostCode<unknown>(sandbox, version.hostCode, plugin.pluginId, VM_TIMEOUT_MS);
				// shape B:hostCode 是工厂表达式(如 `async () => {...}` 或
				// 立即调用)——上一形状把函数嵌套进外层体而从未调用,此处
				// 直接求值调用。兼容两种写法,defineTool 闭包共享。
				if (tools.length === 0) {
					await evaluateHostCode<unknown>(
						sandbox,
						`return (${version.hostCode})()`,
						`${plugin.pluginId}:factory`,
						VM_TIMEOUT_MS,
					);
				}
			} catch (error) {
				return textResult(JSON.stringify({ ok: false, error: `host half failed: ${String(error)}` }));
			}
			if (tools.length === 0) {
				return textResult('{"ok":false,"error":"host half declared no tools via defineTool()"}');
			}
			const customTools: CustomTool[] = tools.map(def => {
				const schema = type(
					Object.fromEntries(
						Object.entries(def.parameters ?? {}).map(([k, kind]) => [
							k,
							type(kind === "number" ? "number" : kind === "boolean" ? "boolean" : "string"),
						]),
					),
				);
				return {
					name: `${DYNAMIC_TOOL_PREFIX}${def.name}`,
					label: def.name,
					description: def.description ?? `dynamic tool from plugin ${plugin.pluginId}`,
					parameters: schema,
					async execute(
						_toolCallId2: string,
						params2: Record<string, unknown>,
						_onUpdate2,
						_ctx2: CustomToolContext,
						_signal2?: AbortSignal,
					): Promise<AgentToolResult<any, Record<string, unknown>>> {
						try {
							const text = await Promise.race([
								Promise.resolve(def.run(params2)),
								new Promise<string>((_, reject) =>
									setTimeout(() => reject(new Error(`dynamic tool "${def.name}" timed out`)), VM_TIMEOUT_MS),
								),
							]);
							return textResult(typeof text === "string" ? text : JSON.stringify(text));
						} catch (error) {
							return textResult(JSON.stringify({ ok: false, error: String(error) }));
						}
					},
				} as CustomTool;
			});
			// 写入活动 run 后全量 reconcile(本插件旧工具被同 plugins 覆盖,
			// 其他插件工具保留)。
			plugin.activeRun = {
				packageId: version.packageId,
				customTools,
				startedAt: Date.now(),
			};
			await session.setDynamicTools(registry.allActiveCustomTools());
			return textResult(
				JSON.stringify(
					{
						ok: true,
						pluginId: plugin.pluginId,
						packageId: version.packageId,
						tools: customTools.map(t => t.name),
					},
					null,
					2,
				),
			);
		},
	};

	const stopTool: CustomTool<typeof simpleSchema> = {
		name: "ext_stop",
		label: "停用动态插件",
		description: "停用插件:移除该插件全部动态工具,会话工具链立即 reconcile。",
		parameters: simpleSchema,
		async execute(
			_toolCallId: string,
			params: typeof simpleSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof simpleSchema.infer>> {
			const session = sessionOf(ctx);
			if (!session) return textResult('{"ok":false,"error":"no live session"}');
			const p = params as SimpleParams;
			const registry = registryFor(ctx);
			const plugin = registry.get(p.pluginId);
			if (!plugin) return textResult(`{"ok":false,"error":"plugin ${p.pluginId} does not exist"}`);
			if (!plugin.activeRun) return textResult(`{"ok":false,"error":"plugin ${p.pluginId} is not running"}`);
			plugin.activeRun = undefined;
			await session.setDynamicTools(registry.allActiveCustomTools());
			return textResult(JSON.stringify({ ok: true, stopped: p.pluginId }));
		},
	};

	const undefineTool: CustomTool<typeof simpleSchema> = {
		name: "ext_undefine",
		label: "删除动态插件",
		description: "删除插件及全部版本;活动 run 先停用。",
		parameters: simpleSchema,
		async execute(
			_toolCallId: string,
			params: typeof simpleSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof simpleSchema.infer>> {
			const session = sessionOf(ctx);
			if (!session) return textResult('{"ok":false,"error":"no live session"}');
			const p = params as SimpleParams;
			const registry = registryFor(ctx);
			const plugin = registry.get(p.pluginId);
			if (!plugin) return textResult(`{"ok":false,"error":"plugin ${p.pluginId} does not exist"}`);
			const wasRunning = plugin.activeRun !== undefined;
			if (wasRunning) {
				plugin.activeRun = undefined;
				await session.setDynamicTools(registry.allActiveCustomTools());
			}
			registry.delete(p.pluginId);
			return textResult(JSON.stringify({ ok: true, removed: p.pluginId, wasRunning }));
		},
	};

	const inspectTool: CustomTool<typeof inspectSchema> = {
		name: "ext_inspect",
		label: "检查动态插件",
		description: "会话动态插件注册表快照:插件/版本数/活动 run/工具名。只读。",
		parameters: inspectSchema,
		async execute(
			_toolCallId: string,
			params: typeof inspectSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof inspectSchema.infer>> {
			const registry = registryFor(ctx);
			const p = params as { pluginId?: string };
			if (p.pluginId) {
				const plugin = registry.get(p.pluginId);
				return textResult(
					JSON.stringify(
						plugin
							? {
									ok: true,
									plugin: {
										pluginId: plugin.pluginId,
										name: plugin.name,
										purpose: plugin.purpose,
										packageCount: plugin.packages.size,
										activePackageId: plugin.activeRun?.packageId,
										activeToolNames: plugin.activeRun?.customTools.map(t => t.name) ?? [],
									},
								}
							: { ok: false, error: `plugin ${p.pluginId} does not exist` },
						null,
						2,
					),
				);
			}
			return textResult(JSON.stringify({ ok: true, plugins: registry.all() }, null, 2));
		},
	};

	return [defineTool, runTool, stopTool, undefineTool, inspectTool];
}
