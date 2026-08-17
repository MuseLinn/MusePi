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
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@musepi/omptype";
import type { AgentToolResult, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";
import type { AgentSession } from "../session/agent-session";

export type LiveSessionLookup = (sessionId: string) => { agentSession: AgentSession } | undefined;

/**
 * P1 版本化回滚:每次 extension_load/reload 成功后把入口所在目录快照到
 * ~/.musepi/extension-backups/<sha1(入口)12>/<ts>/。extension_rollback
 * 恢复最新快照 + 重载会话。保留最近 5 个快照。
 */
const BACKUP_ROOT = path.join(os.homedir(), ".musepi", "extension-backups");
const MAX_SNAPSHOTS = 5;

function backupKey(entryPath: string): string {
	return createHash("sha1").update(path.resolve(entryPath)).digest("hex").slice(0, 12);
}

/** 入口所在目录(入口可为目录或 index.ts)。 */
function extensionDirOf(entryPath: string): string {
	const resolved = path.resolve(entryPath);
	return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
}

/** 快照扩展目录;返回快照路径,失败返回 null。 */
async function snapshotExtension(entryPath: string): Promise<string | null> {
	try {
		const dir = extensionDirOf(entryPath);
		const target = path.join(BACKUP_ROOT, backupKey(entryPath), String(Date.now()));
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.cpSync(dir, target, { recursive: true });
		// 修剪旧快照(保留最新 MAX_SNAPSHOTS 个)。
		const bucket = path.dirname(target);
		const entries = fs.readdirSync(bucket).sort();
		for (const old of entries.slice(0, Math.max(0, entries.length - MAX_SNAPSHOTS))) {
			try {
				fs.rmSync(path.join(bucket, old), { recursive: true, force: true });
			} catch {
				// 修剪失败不影响功能
			}
		}
		return target;
	} catch {
		return null;
	}
}

/** 恢复最新快照到扩展目录;返回恢复的快照路径,无快照返回 null。 */
async function restoreExtensionSnapshot(entryPath: string): Promise<string | null> {
	try {
		const bucket = path.join(BACKUP_ROOT, backupKey(entryPath));
		if (!fs.existsSync(bucket)) return null;
		const snaps = fs.readdirSync(bucket).sort();
		const latest = snaps[snaps.length - 1];
		if (!latest) return null;
		const from = path.join(bucket, latest);
		const dir = extensionDirOf(entryPath);
		fs.cpSync(from, dir, { recursive: true });
		return from;
	} catch {
		return null;
	}
}

const extListSchema = type({});
const extLoadSchema = type({ path: type("string").describe("扩展入口路径(目录或 index.ts)") });
const extReloadSchema = type({ path: type("string").describe("扩展入口路径(目录或 index.ts)") });
const extStatusSchema = type({ "path?": type("string").describe("扩展入口路径;省略 = 全部") });
const extValidateSchema = type({ path: type("string").describe("扩展入口路径(目录或 index.ts)") });
const extRollbackSchema = type({ path: type("string").describe("扩展入口路径(目录或 index.ts)") });

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text }] };
}

export function createExtensionManagerTools(
	sessionOf: (ctx: CustomToolContext) => AgentSession | null,
): Array<CustomTool<any, any>> {
	const extensionsListTool: CustomTool<typeof extListSchema> = {
		name: "extensions_list",
		label: "扩展清单",
		description: "列出当前会话已加载的扩展:路径/工具名/预设/提示词区块/槽位组件。只读,无副作用。",
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
			// P1 版本化回滚:加载成功即快照,extension_rollback 可回退。
			if (res.errors.length === 0) await snapshotExtension(p.path);
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
			// P1 版本化回滚:重载成功即快照,extension_rollback 可回退。
			if (res.errors.length === 0) await snapshotExtension(p.path);
			return textResult(
				JSON.stringify(
					{
						ok: res.errors.length === 0,
						removedTools: res.removedTools,
						errors: res.errors,
						deferred: res.deferred,
					},
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
			return textResult(
				JSON.stringify({ ok: true, extensions: list, allToolNames: session.listAllExtensionTools() }, null, 2),
			);
		},
	};

	const extensionValidateTool: CustomTool<typeof extValidateSchema> = {
		name: "extension_validate",
		label: "校验扩展",
		description: "校验扩展:入口存在性 + 加载错误(语法/注册失败) + 槽位组件编译。不注册到会话,无副作用。",
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
			const { validateExtensionComponents } = await import("./extension-artifact-compiler");
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

	const extensionRollbackTool: CustomTool<typeof extRollbackSchema> = {
		name: "extension_rollback",
		label: "回滚扩展",
		description:
			"把指定扩展回滚到最近一次 load/reload 成功的版本(快照位于 ~/.musepi/extension-backups),然后重载会话。用于修复损坏的新版本。",
		parameters: extRollbackSchema,
		async execute(
			_toolCallId: string,
			params: typeof extRollbackSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof extRollbackSchema.infer>> {
			const session = sessionOf(ctx);
			if (!session) return textResult('{"ok":false,"error":"no live session"}');
			const p = params as { path: string };
			const restored = await restoreExtensionSnapshot(p.path);
			if (!restored) return textResult('{"ok":false,"error":"no snapshot to restore (该扩展从未成功加载过)"}');
			const res = await session.reloadExtension(p.path);
			return textResult(
				JSON.stringify(
					{
						ok: res.errors.length === 0,
						restoredFrom: restored,
						removedTools: res.removedTools,
						errors: res.errors,
						deferred: res.deferred,
					},
					null,
					2,
				),
			);
		},
	};

	return [
		extensionsListTool,
		extensionLoadTool,
		extensionReloadTool,
		extensionStatusTool,
		extensionValidateTool,
		extensionRollbackTool,
	];
}
