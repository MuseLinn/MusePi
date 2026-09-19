import { type TranslationKey, t } from "@musepi/guest-client";

/** One entry of the daemon `modes.list` catalog (builtin presets + user-created). */
export interface ModeLabelEntry {
	id: string;
	label: string;
}

/**
 * 会话预设取名链 — ContextPanel 右栏头部与 SessionHoverCard 悬浮卡共用，
 * 两处必须永远显示同一个名字：
 *
 * 1. 内置预设（work/chat/creator/design）走 i18n `mode {id}` 词表（daemon
 *    端已本地化）；
 * 2. `t()` 回显 key 本身 = 词表未收录（用户创建/插件注册的预设）→ 查
 *    `modes.list` catalog：那是用户模式真名的唯一来源；
 * 3. catalog 也没有（daemon 未连接/目录过期）→ 回落 "default mode"，
 *    绝不把裸 id 打给用户。
 */
export function resolveModeLabel(
	modeId: string | null | undefined,
	catalog?: readonly ModeLabelEntry[] | null,
): string {
	const id = (modeId ?? "").trim();
	if (!id) return t("default mode");
	const key = `mode ${id}` as TranslationKey;
	const label = t(key);
	if (label !== key) return label;
	const entry = catalog?.find(m => m.id === id);
	return entry?.label?.trim() ? entry.label.trim() : t("default mode");
}
