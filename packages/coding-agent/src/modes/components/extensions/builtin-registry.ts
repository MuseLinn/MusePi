/**
 * 内置扩展注册表(DSH builtins 对齐,增量补齐)。
 *
 * DSH 语义:内置插件 = 部署物(bundle/inline),只读不可改删,可禁用(patch
 * disable)。musepi 此前把唯一的 inline 内置扩展(task-card-swarm)硬编码在
 * state-manager —— 注册表把"内置扩展"变成显式概念:
 *
 * - 声明集中:新增内置扩展只需往 BUILTIN_EXTENSIONS 加一项(不再改两处)。
 * - 只读保护:内置项 path 恒为空(无文件可 reload/rollback),level=native
 *   (GUI/daemon 的既有删除/禁用保护判定复用)。
 * - 可禁用:通用项走 disabledExtensions;镜像设置的项(settingsMirror)由
 *   daemon 的 extensions.setEnabled 写对应设置键(server.ts 特判保留)。
 */

import { type Extension, type ExtensionKind, makeExtensionId } from "./types";

/** 内置扩展定义:注册表一行 = 一个部署内置扩展。 */
export interface BuiltinExtensionDef {
	kind: ExtensionKind;
	name: string;
	displayName: string;
	description?: string;
	/** 镜像设置键的内置扩展(state 由设置驱动,setEnabled 写设置而非禁用列表)。 */
	settingsMirror?: { key: string; on: unknown; off: unknown };
	/** inspector 的 raw 载荷。 */
	raw: unknown;
}

/** 内置扩展注册表(只读部署物;增补 = 加一行)。 */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtensionDef[] = [
	{
		kind: "style",
		name: "task-card-swarm",
		displayName: "Swarm Task Card",
		description:
			"Kimi-parity task/swarm card style: member grid with per-agent avatars, progress bars and accordion outputs",
		settingsMirror: { key: "display.taskCardStyle", on: "swarm", off: "classic" },
		raw: { name: "task-card-swarm", style: "swarm" },
	},
];

/** 生成内置扩展条目(state 按 disabledExtensions 计算;镜像设置的项由
 *  daemon extensions.list 在响应时改写 state —— 与注册前行为一致)。 */
export function builtinExtensionEntries(disabledExtensions: ReadonlySet<string>): Extension[] {
	return BUILTIN_EXTENSIONS.map(def => {
		const id = makeExtensionId(def.kind, def.name);
		return {
			id,
			kind: def.kind,
			name: def.name,
			displayName: def.displayName,
			description: def.description,
			trigger: undefined,
			path: "",
			source: { provider: "native", providerName: "Builtin", level: "native" },
			state: disabledExtensions.has(id) ? "disabled" : "active",
			disabledReason: disabledExtensions.has(id) ? "item-disabled" : undefined,
			raw: def.raw,
		};
	});
}
