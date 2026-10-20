/**
 * 模块条目的 kind —— 两条加载轨道在清单上分名。
 *
 * 本仓库有两条插件加载轨道（`docs/plugin-tracks.md` 是权威说明）：
 *
 * - **plugin**（cordis 轨）：`extensibility/plugins/` 的加载器装载的条目，
 *   入口是 cordis 三元组（`apply`/`inject`/`provide`），支持类形态入口、
 *   服务发布/注入、HMR 整图重载。
 * - **legacy extension**（兼容轨）：`extensibility/extensions/` 的旧 Pi/omp
 *   加载器装载的条目，仅为既有 `.omp`/`.pi` 目录保留，不新增能力。
 *
 * 两条轨道在 `extensions.list` 上共用过一个 `extension-module` kind，于是
 * 一条清单行无法说明自己是哪条轨道装载的——排查加载问题只能靠猜去哪边的
 * 日志里找。现在 kind 按轨道分名，这是**显示属性**，与身份无关（见下行）。
 *
 * ⚠️ **身份与状态都不在这里**：条目身份是插件名（`plugin-identity.ts` 的
 * `pluginEntryId`），启停是这个名字上的一个布尔值——与 dsh 的
 * `PluginEntryId` + `entry.disabled` 同模型。kind 只是分类标签，改它不会让
 * 任何用户状态失配。
 */

import { pluginEntryId, pluginNameOfEntryId } from "./plugin-identity";

/** kind 值：cordis 轨（Track A）。`extensions.list` 的 `kind` 字段。 */
export const PLUGIN_MODULE_KIND = "plugin-module";

/** kind 值：legacy 兼容轨（Track B）。与既有清单行完全同值，零迁移。 */
export const LEGACY_EXTENSION_MODULE_KIND = "extension-module";

/**
 * 一个模块条目的身份键 = 插件名本身（与 dsh 的 `PluginEntryId` 同模型）。
 *
 * 历史包袱：存量 `disabledExtensions` 用 `extension-module:<name>` 拼接串记录，
 * 于是「分类」被焊进了「身份」——改分类就会让用户的启停状态失配。身份不该含
 * 轨道信息，这里改为裸名。存量两种前缀仍被读取（`plugin-identity.ts` 的
 * `legacyModuleEntryIds`），写入只写裸名，老数据在用户下一次切换时自然迁移。
 */
export function moduleEntryId(name: string): string {
	return pluginEntryId(name);
}

/** 从一个模块条目 id 里取模块名（裸名与两种历史前缀都认）。 */
export function moduleEntryName(id: string): string {
	return pluginNameOfEntryId(id) ?? id;
}

/**
 * 判断一个 kind 是否是模块条目（两条轨道都算）。
 *
 * 消费方写 `isModuleEntryKind(entry.kind)` 而不是
 * `entry.kind === "extension-module" || entry.kind === PLUGIN_MODULE_KIND`——
 * 比较逻辑只有这里一份，将来加第三条轨道时改一处。
 */
export function isModuleEntryKind(kind: string): boolean {
	return kind === PLUGIN_MODULE_KIND || kind === LEGACY_EXTENSION_MODULE_KIND;
}
