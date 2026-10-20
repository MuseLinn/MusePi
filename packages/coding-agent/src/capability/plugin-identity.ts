/**
 * 插件条目的身份与启停 —— 与 dsh 的 `PluginEntryId` 同模型。
 *
 * ## dsh 怎么做的（源码对位）
 *
 * | dsh | 位置 |
 * |---|---|
 * | `PluginEntryId` = `Branded<'PluginEntryId'>`，Loader 树条目的稳定身份 | `host/plugin-inventory/src/types.ts:5` |
 * | 启停 = 清单条目自己的 `disabled: boolean` 字段 | `boot/plugin-manager/src/patch.ts:51` |
 * | 身份**不含**「kind」——dsh 只有一条轨道 | — |
 *
 * 关键点：dsh 的启停**不是**「某个字符串出现在某个列表里」，而是**条目自己带一个
 * 布尔值**。身份（它是谁）与状态（它开没开）是两个独立字段，结构上就不会互相污染。
 *
 * ## 我们之前错在哪
 *
 * 存量实现用 `disabledExtensions: string[]`，键是 `kind:name` 拼接串
 * （`extension-module:musepi-auth-hub`）。由此产生两个问题：
 *
 * 1. **身份被 kind 污染**：改一个插件的「分类」会让它看起来是另一个插件，用户
 *    保存的启停状态因此失配。
 * 2. **两条轨道被迫共用同一个 kind 前缀**，于是不得不设计「kind 与启停键解耦」
 *    这种绕法——而 dsh 根本不需要它，因为 dsh 的记录方式不存在这个耦合。
 *
 * ## 现在的模型
 *
 * - **身份** = 插件名（包名），例如 `musepi-auth-hub`。这是它在插件树里的稳定标识。
 * - **启停** = 以该身份为键的布尔值。
 * - 轨道（cordis / legacy）是条目的**属性**，不是身份的一部分。
 *
 * ## 迁移
 *
 * 存量 `disabledExtensions` 里的 `extension-module:<name>` 与 `plugin-module:<name>`
 * 都**继续被识别**（见 {@link legacyModuleEntryIds}）。读的时候两种都认，写的时候
 * 只写新键——老数据在用户下一次切换时自然迁过去，不需要一次性迁移脚本。
 */

/** 一个插件条目的稳定身份：插件名（包名）。 */
export type PluginEntryId = string;

/**
 * 旧版把 kind 拼进 id 的前缀。"extension-module" 是历史遗留的那一个，
 * "plugin-module" 是上一轮引入但同样不该存在的那一个。
 */
const LEGACY_MODULE_KIND_PREFIXES = ["extension-module:", "plugin-module:"] as const;

/** 一个插件名 → 新的启停键（就是它自己）。 */
export function pluginEntryId(name: string): PluginEntryId {
	return name;
}

/**
 * 一个插件名在存量数据里可能出现的全部写法（新的在前）。
 *
 * ⚠️ 只用于**读**。写入一律走 {@link pluginEntryId}——两种写法都写会让同一状态
 * 有两份记录，将来必然有一份过期。
 */
export function legacyModuleEntryIds(name: string): string[] {
	return [pluginEntryId(name), ...LEGACY_MODULE_KIND_PREFIXES.map(prefix => `${prefix}${name}`)];
}

/**
 * 从一条存量记录里取出插件名；不是插件条目则返回 `undefined`。
 *
 * 认三种写法：裸名（新）、`extension-module:<name>`、`plugin-module:<name>`。
 */
export function pluginNameOfEntryId(id: string): string | undefined {
	for (const prefix of LEGACY_MODULE_KIND_PREFIXES) {
		if (id.startsWith(prefix)) return id.slice(prefix.length);
	}
	// A bare id is the new form. Reject the other capability kinds' composites
	// (`skill:`, `hook:`, …) so a hook id is never mistaken for a plugin.
	return id.includes(":") ? undefined : id;
}

/**
 * 该插件是否被禁用。
 *
 * @param disabledEntries - 存量/新式的启停记录（`disabledExtensions` 的全集）。
 * @param name - 插件名。
 */
export function isPluginDisabled(disabledEntries: Iterable<string>, name: string): boolean {
	const set = disabledEntries instanceof Set ? disabledEntries : new Set(disabledEntries);
	return legacyModuleEntryIds(name).some(id => set.has(id));
}

/**
 * 把「启用/禁用」结果写回启停记录集合，返回新的全集。
 *
 * 新键写入/删除，**同时**清掉同类目的旧键——否则老键会一直留在列表里，
 * 且两种写法可能给出相反结论（一处启用、一处禁用），下一次读取就无法判断。
 *
 * @param entries - 现有记录。
 * @param name - 插件名。
 * @param enabled - 目标状态。
 */
export function setPluginEnabledIn(entries: readonly string[], name: string, enabled: boolean): string[] {
	const stale = new Set(legacyModuleEntryIds(name));
	const out = entries.filter(id => !stale.has(id));
	if (!enabled) out.push(pluginEntryId(name));
	return out;
}
