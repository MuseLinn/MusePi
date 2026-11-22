/**
 * P2 会话级动态 Cordis 插件工具链（cordis-host-runner 的 MusePi 落地，无审批）：
 *
 * 会话内 agent 定义→运行→停用→删除动态插件，全程沙箱隔离：
 * - cordis_define  { name, purpose, hostCode, idPrefix?, pluginId? }
 *     定义不可变包（pluginId 省略 = 新插件，提供 = 追加版本）。只定义、不运行。
 * - cordis_run     { pluginId, packageId?, mode? }
 *     激活版本（packageId 省略 = 最新）：vm 沙箱执行 host 半体 → defineTool
 *     注册工具 → 写入会话工具链（extdyn__ 命名空间，立即对模型可见）。
 *     mode=run 首次激活/重启当前；mode=update 切换版本（要求已在运行）。
 * - cordis_stop    { pluginId }   停用：移除该插件全部动态工具，保留定义与版本。
 * - cordis_undefine{ pluginId }   删除插件（含活动 run 与全部版本）。
 * - cordis_inspect { platform?, provider?, method? }
 *     API 目录;给全 provider+method 即精确查询。
 * - cordis_inspect_list / cordis_inspect_query
 *     只读运行时 API 目录与精确契约（slots / tools 可列）。
 * - cordis_inspect_self { pluginId?, packageId? }
 *     注册表快照；两者都给时返回该版本的 hostCode 源码，用于原位修复。
 *
 * 工具名命名空间 `extdyn__<name>`（MCP `mcp__` 同款约定），避免与内置
 * 工具冲突；同一会话内工具全量 reconcile —— 会话间注册表独立。
 */

import { type } from "@musepi/musepi-type";
import type { AgentToolResult, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import type { AgentSession } from "../session/agent-session";
import { inspectProviderDirectory, inspectQuery } from "./cordis-inspect";
import { createSandbox, evaluateHostCode, precheckCode, type SandboxToolDefinition } from "./plugin-sandbox";

/** 动态工具注册名前缀(与 isMCPToolName 同族约定)。 */
export const DYNAMIC_TOOL_PREFIX = "extdyn__";

const VM_TIMEOUT_MS = 5_000;

export interface RuntimePackageVersion {
	packageId: string;
	hostCode: string;
	createdAt: number;
}

export interface RuntimePluginRun {
	packageId: string;
	/** 本次激活标识（cordis_run 回执；失败诊断与 UI 卡片用）。 */
	runId: string;
	/** 活动动态工具(注册名 = extdyn__name;全量 reconcile 用)。 */
	customTools: CustomTool[];
	startedAt: number;
}

export interface RuntimePlugin {
	pluginId: string;
	sessionId: string;
	name: string;
	purpose: string;
	packages: Map<string, RuntimePackageVersion>;
	activeRun?: RuntimePluginRun;
}

export interface RuntimePluginSnapshot {
	pluginId: string;
	name: string;
	purpose: string;
	packageCount: number;
	activePackageId?: string;
	activeRunId?: string;
	activeToolNames: string[];
}

/** 会话级动态插件注册表(进程内存;不可变版本 + 单活动 run)。 */
export class RuntimeToolRegistry {
	readonly #plugins = new Map<string, RuntimePlugin>();
	#pluginSeq = 0;
	#packageSeq = 0;
	#runSeq = 0;

	mintPluginId(prefix: string): string {
		return `${prefix}${String(++this.#pluginSeq).padStart(3, "0")}`;
	}

	mintPackageId(): string {
		return `pkg${String(++this.#packageSeq).padStart(3, "0")}`;
	}

	mintRunId(): string {
		return `run${String(++this.#runSeq).padStart(3, "0")}`;
	}

	get(pluginId: string): RuntimePlugin | undefined {
		return this.#plugins.get(pluginId);
	}

	all(): RuntimePluginSnapshot[] {
		const out: RuntimePluginSnapshot[] = [];
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

	#snapshot(plugin: RuntimePlugin): RuntimePluginSnapshot {
		return {
			pluginId: plugin.pluginId,
			name: plugin.name,
			purpose: plugin.purpose,
			packageCount: plugin.packages.size,
			activePackageId: plugin.activeRun?.packageId,
			activeRunId: plugin.activeRun?.runId,
			activeToolNames: plugin.activeRun?.customTools.map(t => t.name) ?? [],
		};
	}

	put(plugin: RuntimePlugin): void {
		this.#plugins.set(plugin.pluginId, plugin);
	}

	delete(pluginId: string): RuntimePlugin | undefined {
		const plugin = this.#plugins.get(pluginId);
		this.#plugins.delete(pluginId);
		return plugin;
	}
}

interface DefineParams {
	name: string;
	purpose: string;
	hostCode: string;
	idPrefix?: string;
	pluginId?: string;
}

interface RunParams {
	pluginId: string;
	packageId?: string;
	mode?: string;
}

interface SimpleParams {
	pluginId: string;
}

export type LiveSessionLookup = (sessionId: string) => { agentSession: AgentSession } | undefined;

/**
 * 创建动态插件工具链。`sessionOf(ctx)` 与 extension-lifecycle-tools 同款
 * (会话查表由 DaemonSessionHost 注入),每个会话持有独立 registry。
 */
export function createExtensionRuntimeTools(
	sessionOf: (ctx: CustomToolContext) => AgentSession | null,
	registryFor: (ctx: CustomToolContext) => RuntimeToolRegistry,
): Array<CustomTool<any, any>> {
	const defineSchema = type({
		name: type("string").describe("插件名(非空,一行)"),
		purpose: type("string").describe("插件用途(非空,一行说明它对用户做什么)"),
		hostCode: type("string").describe(
			"host 半体:async 函数体。只能调用注入的 defineTool({name,description,parameters,run})、setTimeout、clearTimeout、console;不要写 TypeScript、JSX、import 或 require",
		),
		idPrefix: type("string").describe("新插件的语义 id 前缀:3–6 个小写英文字母(如 clock);省略 = dyn").optional(),
		pluginId: type("string").describe("省略 = 新建插件;提供 = 给该插件追加一个不可变版本").optional(),
	});
	const runSchema = type({
		pluginId: type("string").describe("插件 id(cordis_define 返回值)"),
		packageId: type("string").describe("省略 = 激活最新版本").optional(),
		mode: type("string")
			.describe("run = 首次激活或重启当前版本(默认);update = 切换到目标版本,要求该插件已在运行")
			.optional(),
	});
	const simpleSchema = type({
		pluginId: type("string").describe("插件 id"),
	});
	const inspectSelfSchema = type({
		pluginId: type("string").describe("省略 = 全部插件").optional(),
		packageId: type("string").describe("与 pluginId 同时给出时返回该版本的 hostCode 源码").optional(),
	});
	const inspectListSchema = type({
		platform: type("string").describe("仅 host;省略 = 全部").optional(),
	});
	const inspectQuerySchema = type({
		platform: type("string").describe("host").optional(),
		provider: type("string").describe("目录中的 provider 名(如 runtime / package / slots / tools)"),
		method: type("string").describe("目录中该 provider 的方法名"),
	});
	const inspectSchema = type({
		platform: type("string").describe("host").optional(),
		provider: type("string").describe("给 provider+method = 精确查询;省略 = 目录").optional(),
		method: type("string").describe("目录中该 provider 的方法名").optional(),
	});

	const textResult = (text: string): { content: Array<{ type: "text"; text: string }> } => ({
		content: [{ type: "text", text }],
	});

	const defineTool: CustomTool<typeof defineSchema> = {
		name: "cordis_define",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "定义 Cordis 插件",
		description:
			"定义一个动态 Cordis 插件版本(不可变包)。只定义、不运行:hostCode 语法预检通过后存入会话注册表,返回 pluginId 与 packageId。hostCode 是 async 函数体,只能调用注入的 defineTool({name,description,parameters,run})、setTimeout、clearTimeout、console;不要写 TypeScript、JSX、import 或 require。插件只存在于当前会话,不写盘。给已有插件追加版本时传 pluginId 与新的 hostCode。",
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
			const idPrefix = p.idPrefix?.trim() ?? "";
			if (name.length === 0) return textResult('{"ok":false,"error":"cordis_define needs a non-empty name"}');
			if (purpose.length === 0) return textResult('{"ok":false,"error":"cordis_define needs a non-empty purpose"}');
			if (p.hostCode.length === 0)
				return textResult('{"ok":false,"error":"cordis_define needs non-empty hostCode"}');
			if (idPrefix.length > 0 && !/^[a-z]{3,6}$/.test(idPrefix)) {
				return textResult(
					'{"ok":false,"error":"cordis_define idPrefix must be 3–6 lowercase English letters (for example clock)"}',
				);
			}
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
				const minted = registry.mintPluginId(idPrefix.length > 0 ? idPrefix : "dyn");
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
		name: "cordis_run",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "运行 Cordis 插件",
		description:
			"激活一个插件版本:在 vm 沙箱执行 host 半体,defineTool 声明的工具立即注册进会话工具链(extdyn__ 前缀),下一次模型调用即可用。mode=run(默认)用于首次激活或重启当前版本;mode=update 用于切换到目标版本,要求该插件已在运行。同一插件重新运行 = 热更新版本,旧版本工具被替换。",
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
			const mode = p.mode?.trim() || "run";
			if (mode !== "run" && mode !== "update") {
				return textResult('{"ok":false,"error":"cordis_run mode must be \\"run\\" or \\"update\\""}');
			}
			const registry = registryFor(ctx);
			const plugin = registry.get(p.pluginId);
			if (!plugin) return textResult(`{"ok":false,"error":"plugin ${p.pluginId} does not exist"}`);
			if (mode === "update" && !plugin.activeRun) {
				return textResult(
					`{"ok":false,"error":"cordis_run mode=update requires plugin ${p.pluginId} to be running; use mode=run for the first activation"}`,
				);
			}
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
				// shape A:hostCode 是 async 函数体(evaluateHostCode 语义,
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
			const runId = registry.mintRunId();
			plugin.activeRun = {
				packageId: version.packageId,
				runId,
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
						runId,
						mode,
						tools: customTools.map(t => t.name),
					},
					null,
					2,
				),
			);
		},
	};

	const stopTool: CustomTool<typeof simpleSchema> = {
		name: "cordis_stop",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "停用 Cordis 插件",
		description:
			"停用插件:移除该插件全部动态工具,会话工具链立即 reconcile。插件定义与全部版本保留,之后可用 cordis_run 重新激活。",
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
		name: "cordis_undefine",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "删除 Cordis 插件",
		description: "删除插件及其全部版本,活动 run 先停用。只在确认用户不再需要该插件时使用;不可恢复。",
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

	const inspectSelfTool: CustomTool<typeof inspectSelfSchema> = {
		name: "cordis_inspect_self",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "检查 Cordis 插件",
		description:
			"当前会话的动态插件注册表:插件/版本数/活动 run/工具名。只读。pluginId 与 packageId 同时给出时额外返回该不可变版本的 hostCode 源码,用于失败后原位修复(追加修正版本,不要另建插件)。",
		parameters: inspectSelfSchema,
		async execute(
			_toolCallId: string,
			params: typeof inspectSelfSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof inspectSelfSchema.infer>> {
			const registry = registryFor(ctx);
			const p = params as { pluginId?: string; packageId?: string };
			if (p.pluginId) {
				const plugin = registry.get(p.pluginId);
				if (!plugin) return textResult(`{"ok":false,"error":"plugin ${p.pluginId} does not exist"}`);
				const base = {
					pluginId: plugin.pluginId,
					name: plugin.name,
					purpose: plugin.purpose,
					packageCount: plugin.packages.size,
					activePackageId: plugin.activeRun?.packageId,
					activeRunId: plugin.activeRun?.runId,
					activeToolNames: plugin.activeRun?.customTools.map(t => t.name) ?? [],
				};
				const version = p.packageId ? plugin.packages.get(p.packageId) : undefined;
				if (p.packageId && !version) {
					return textResult(`{"ok":false,"error":"package ${p.packageId} not found"}`);
				}
				return textResult(
					JSON.stringify(
						version
							? {
									ok: true,
									plugin: base,
									source: {
										pluginId: plugin.pluginId,
										packageId: version.packageId,
										hostCode: version.hostCode,
									},
								}
							: { ok: true, plugin: base },
						null,
						2,
					),
				);
			}
			return textResult(JSON.stringify({ ok: true, plugins: registry.all() }, null, 2));
		},
	};

	const inspectListTool: CustomTool<typeof inspectListSchema> = {
		name: "cordis_inspect_list",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "列出 Cordis API",
		description:
			"列出动态插件可用的只读运行时 API 目录:platform / provider / method。写代码或配置插件前先查,再用 cordis_inspect_query 取精确契约。只读。",
		parameters: inspectListSchema,
		async execute(
			_toolCallId: string,
			params: typeof inspectListSchema.infer,
			_onUpdate,
			_ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof inspectListSchema.infer>> {
			const p = params as { platform?: string };
			const providers = inspectProviderDirectory().filter(
				provider => p.platform === undefined || provider.platform === p.platform,
			);
			return textResult(JSON.stringify({ ok: true, providers }, null, 2));
		},
	};

	const inspectQueryTool: CustomTool<typeof inspectQuerySchema> = {
		name: "cordis_inspect_query",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "查询 Cordis API",
		description:
			"按目录条目精确查询一个运行时 API 的签名与输入契约(cordis_inspect_list 返回值里的 platform/provider/method),或列出 slots/tools。只读:不调用业务方法、不修改运行时。",
		parameters: inspectQuerySchema,
		async execute(
			_toolCallId: string,
			params: typeof inspectQuerySchema.infer,
			_onUpdate,
			_ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof inspectQuerySchema.infer>> {
			const p = params as { platform?: string; provider: string; method: string };
			return textResult(
				JSON.stringify(
					inspectQuery({
						provider: p.provider,
						method: p.method,
						...(p.platform ? { platform: p.platform } : {}),
					}),
					null,
					2,
				),
			);
		},
	};

	const inspectTool: CustomTool<typeof inspectSchema> = {
		name: "cordis_inspect",
		defaultInactive: true, // issue #38 Step 2: 默认不激活,/extensions 挂载
		label: "检查 Cordis API",
		description:
			"运行时 API 目录:省略 provider+method 返回目录;两者都给时等价 cordis_inspect_query。只读。会话插件/版本/源码用 cordis_inspect_self。",
		parameters: inspectSchema,
		async execute(
			_toolCallId: string,
			params: typeof inspectSchema.infer,
			_onUpdate,
			_ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof inspectSchema.infer>> {
			const p = params as { platform?: string; provider?: string; method?: string };
			if (p.provider !== undefined && p.method !== undefined) {
				return textResult(
					JSON.stringify(
						inspectQuery({
							provider: p.provider,
							method: p.method,
							...(p.platform ? { platform: p.platform } : {}),
						}),
						null,
						2,
					),
				);
			}
			const providers = inspectProviderDirectory().filter(
				provider => p.platform === undefined || provider.platform === p.platform,
			);
			return textResult(JSON.stringify({ ok: true, providers }, null, 2));
		},
	};

	return [
		defineTool,
		runTool,
		stopTool,
		undefineTool,
		inspectListTool,
		inspectQueryTool,
		inspectSelfTool,
		inspectTool,
	];
}
