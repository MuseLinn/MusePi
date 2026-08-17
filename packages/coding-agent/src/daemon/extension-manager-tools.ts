/**
 * P0 自举:agent 扩展管理工具(extension_* 工具集,DSH tool-cordis 参考吸收)。
 *
 * 会话级——操作调用者所在会话的 runner:load/reload 走 AgentSession 的
 * busy gate(streaming 时 park 到 agent_end);只读查询走 listLoadedExtensions
 * 投影(不暴露 runner 本体)。由 daemon 注入 createSession/activate 的
 * customTools,使 agent 能在会话内自举扩展:写文件 → extension_load →
 * 出错 → extension_status 自查 → extension_reload 自修。
 *
 * 独立文件(server.ts 已 7900+ 行,不再加重):daemon 侧只留一行装配。
 */
import { type } from "@musepi/omptype";
import type { AgentToolResult, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import type { AgentSession } from "../session/agent-session";

export type LiveSessionLookup = (sessionId: string) => { agentSession: AgentSession } | undefined;

const extListSchema = type({});
const extLoadSchema = type({ path: type("string").describe("扩展入口路径(目录或 index.ts)") });
const extReloadSchema = type({ path: type("string").describe("扩展入口路径(目录或 index.ts)") });
const extStatusSchema = type({ "path?": type("string").describe("扩展入口路径;省略 = 全部") });
const extValidateSchema = type({ path: type("string").describe("扩展入口路径(目录或 index.ts)") });

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text }] };
}

export function createExtensionManagerTools(
	sessionOf: (ctx: CustomToolContext) => AgentSession | null,
): Array<CustomTool<any, any>> {
	const extensionsListTool: CustomTool<typeof extListSchema> = {
	name: "extensions_list",
	label: "扩展清单",
	description:
		"列出当前会话已加载的扩展:路径/工具名/预设/提示词区块/槽位组件。只读,无副作用。",
	parameters: extListSchema,
	async execute(
		_toolCallId: string,
		_params: typeof extListSchema.infer,
		_onUpdate,
		ctx: CustomToolContext,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<any, typeof extListSchema.infer>> {
		const session = sessionOf(ctx);
		if (!session) return textResult('{"ok":false,"error":"no live session"}');
		return textResult(JSON.stringify({ ok: true, extensions: session.listLoadedExtensions() }, null, 2));
	},
};

const extensionLoadTool: CustomTool<typeof extLoadSchema> = {
	name: "extension_load",
	label: "加载扩展",
	description:
		"把指定路径的扩展(目录或 index.ts)加载进当前会话:工具/预设/提示词区块/组件注册。已加载 = no-op;streaming 时会话在空闲边界执行(deferred=true)。",
	parameters: extLoadSchema,
	async execute(
		_toolCallId: string,
		params: typeof extLoadSchema.infer,
		_onUpdate,
		ctx: CustomToolContext,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<any, typeof extLoadSchema.infer>> {
		const session = sessionOf(ctx);
		if (!session) return textResult('{"ok":false,"error":"no live session"}');
		const p = params as { path: string };
		const res = await session.loadExtension(p.path);
		return textResult(
			JSON.stringify(
				{ ok: res.errors.length === 0, addedTools: res.addedTools, errors: res.errors, deferred: res.deferred },
				null,
				2,
			),
		);
	},
};

const extensionReloadTool: CustomTool<typeof extReloadSchema> = {
	name: "extension_reload",
	label: "重载扩展",
	description:
		"重载指定扩展:磁盘上的新版本替换会话内实例(工具/预设/提示词区块更新);旧工具不再注册的被移除。streaming 时会话在空闲边界执行(deferred=true)。",
	parameters: extReloadSchema,
	async execute(
		_toolCallId: string,
		params: typeof extReloadSchema.infer,
		_onUpdate,
		ctx: CustomToolContext,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<any, typeof extReloadSchema.infer>> {
		const session = sessionOf(ctx);
		if (!session) return textResult('{"ok":false,"error":"no live session"}');
		const p = params as { path: string };
		const res = await session.reloadExtension(p.path);
		return textResult(
			JSON.stringify(
				{ ok: res.errors.length === 0, removedTools: res.removedTools, errors: res.errors, deferred: res.deferred },
				null,
				2,
			),
		);
	},
};

const extensionStatusTool: CustomTool<typeof extStatusSchema> = {
	name: "extension_status",
	label: "扩展状态",
	description:
		"当前会话扩展状态:全部已加载扩展的工具/预设/提示词区块/组件槽位 + 会话级扩展工具全集。path 省略 = 全部。",
	parameters: extStatusSchema,
	async execute(
		_toolCallId: string,
		params: typeof extStatusSchema.infer,
		_onUpdate,
		ctx: CustomToolContext,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<any, typeof extStatusSchema.infer>> {
		const session = sessionOf(ctx);
		if (!session) return textResult('{"ok":false,"error":"no live session"}');
		const p = params as { path?: string };
		const pp = p.path;
		const all = session.listLoadedExtensions();
		const list = pp ? all.filter(e => e.path === pp || e.path.endsWith(pp)) : all;
		return textResult(JSON.stringify({ ok: true, extensions: list, allToolNames: session.listAllExtensionTools() }, null, 2));
	},
};

const extensionValidateTool: CustomTool<typeof extValidateSchema> = {
	name: "extension_validate",
	label: "校验扩展",
	description:
		"校验扩展:入口存在性 + 加载错误(语法/注册失败) + 槽位组件编译。不注册到会话,无副作用。",
	parameters: extValidateSchema,
	async execute(
		_toolCallId: string,
		params: typeof extValidateSchema.infer,
		_onUpdate,
		ctx: CustomToolContext,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<any, typeof extValidateSchema.infer>> {
		const cwd = ctx.sessionManager.getCwd();
		const { loadExtensions } = await import("../extensibility/extensions/loader");
		const { validateExtensionComponents } = await import("./extension-components");
		const p = params as { path: string };
		const result = await loadExtensions([p.path], cwd);
		const errors = result.errors.map(e => e.error);
		const extension = result.extensions[0];
		if (extension) {
			const bad = await validateExtensionComponents(extension);
			for (const c of bad) errors.push(`component "${c.moduleUrl}" 编译失败: ${c.error}`);
		}
		return textResult(JSON.stringify({ ok: errors.length === 0, errors, loaded: extension !== null }, null, 2));
	},
};

	return [extensionsListTool, extensionLoadTool, extensionReloadTool, extensionStatusTool, extensionValidateTool];
}
