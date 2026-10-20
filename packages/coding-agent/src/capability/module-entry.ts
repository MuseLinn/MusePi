/**
 * 模块条目的 kind 与 id 前缀 —— 两条加载轨道在这里分名。
 *
 * ## 为什么要两个 kind（不能共用一个）
 *
 * 本仓库有两条插件加载轨道（`docs/plugin-tracks.md` 是权威说明）：
 *
 * - **plugin**（cordis 轨）：`extensibility/plugins/` 的加载器装载的条目，
 *   入口是 cordis 三元组（`apply`/`inject`/`provide`），支持类形态入口、
 *   服务发布/注入、HMR 整图重载。
 * - **legacy extension**（兼容轨）：`extensibility/extensions/` 的旧 Pi/omp
 *   加载器装载的条目，仅为既有 `.omp`/`.pi` 目录保留，不新增能力。
 *
 * 两条轨道此前在 `extensions.list` 上共用 `extension-module` 一个 kind——
 * 用户与代码都无法从一条清单行分辨它是哪条轨道装载的，排查加载问题时
 * 「去看哪个加载器的日志」这一步就成了猜测。拆成两个 kind 后：
 *
 * - wire 上可分辨（`kind: "plugin-module"` vs `"extension-module"`）；
 * - 启停键（`disabledExtensions` / 插件配置存储）**不迁移**：两条轨道继续
 *   共用 `extension-module:<name>` 的存量键位（见 `moduleEntryId`）——
 *   改键会让用户已保存的启停状态静默失效，而「哪条轨道装载」不是启停
 *   语义的一部分，不值得为它付迁移成本。
 */

/** kind 值：cordis 轨（Track A）。`extensions.list` 的 `kind` 字段。 */
export const PLUGIN_MODULE_KIND = "plugin-module";

/** kind 值：legacy 兼容轨（Track B）。与既有清单行完全同值，零迁移。 */
export const LEGACY_EXTENSION_MODULE_KIND = "extension-module";

/**
 * 一个模块条目的启停/配置键（两条轨道**共用**）。
 *
 * ⚠️ 这是**存量键位**：`disabledExtensions` 设置与插件配置存储里的既有数据
 * 都以 `extension-module:<name>` 记录。改成按 kind 分前缀等于要求用户重新
 * 启停一遍所有插件——不做。新的 kind 只改变清单行的分类显示与筛选，
 * 不改变「这个模块叫什么」的身份。
 */
export function moduleEntryId(name: string): string {
	return `extension-module:${name}`;
}

/** 从一个模块条目 id 里取模块名（两种 kind 前缀都认）。 */
export function moduleEntryName(id: string): string {
	const marker = ":";
	const idx = id.indexOf(marker);
	return idx === -1 ? id : id.slice(idx + 1);
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
