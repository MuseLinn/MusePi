import { type TranslationKey, t } from "@musepi/client-core";

/** One entry of the daemon `modes.list` catalog (builtin presets + user-created). */
export interface ModeLabelEntry {
	id: string;
	label: string;
}

/**
 * 会话预设取名链 — ContextPanel 右栏头部、SessionHoverCard 悬浮卡与
 * WelcomeComposer 预设 chip/菜单三处共用，永远显示同一个名字：
 *
 * 1. 内置预设（work/chat/creator/design）走 i18n `mode {id}` 词表（daemon
 *    端已本地化）；
 * 2. `t()` 回显 key 本身 = 词表未收录（用户创建/插件注册的预设）→ 查
 *    `modes.list` catalog：那是用户模式真名的唯一来源；
 * 3. catalog 也没有（daemon 未连接/目录过期）→ 回落 "default mode"，
 *    绝不把裸 id 打给用户。
 *
 * 空 id 不走兜底而直接视作 "work"：历史会话 daemon modeId 为 null，而
 * 守护进程默认预设就是 work（与 WelcomeComposer 的 `modeId ?? "work"`
 * 同一约定）——这些会话必须显示 "工作模式"，不是 "默认模式"。
 */
export function resolveModeLabel(
	modeId: string | null | undefined,
	catalog?: readonly ModeLabelEntry[] | null,
): string {
	const id = (modeId ?? "").trim() || "work";
	if (!id) return t("default mode");
	const key = `mode ${id}` as TranslationKey;
	const label = t(key);
	if (label !== key) return label;
	const entry = catalog?.find(m => m.id === id);
	return entry?.label?.trim() ? entry.label.trim() : t("default mode");
}

/**
 * 预设一句话描述 — 预设 chip 菜单（dsh 模式菜单 parity：名称 + 描述两行）。
 * 与 {@link resolveModeLabel} 同链：`mode {id} description` 词表命中即返回；
 * 回显 key（用户/插件预设未收录）返回 null，菜单项退化为单行名称。
 */
export function resolveModeDescription(modeId: string | null | undefined): string | null {
	const id = (modeId ?? "").trim();
	if (!id) return null;
	const key = `mode ${id} description` as TranslationKey;
	const text = t(key);
	return text !== key ? text : null;
}
