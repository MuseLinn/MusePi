/**
 * 技能市场纯逻辑与跨面板共享状态。
 *
 * 已安装判定（发现页卡片角标 + 预览弹窗安装按钮）不能只按市场条目的
 * 显示名匹配：市场卡片的 name 是发布者填的中文名（如「编程专家」），而
 * skills.list 落盘的是 SKILL.md frontmatter 里的 name（如 `dev-expert`），
 * 两者不同名时卡片永远翻不到「已安装」。slug 是目录侧的装键，安装落盘名
 * 与之一致，所以判定取 name/slug 两个键的并集。
 *
 * 图标缓存解决另一个形状差：市场条目带 iconUrl，已安装条目来自本地
 * SKILL.md 解析没有 icon 字段，「我安装的」卡片只剩灰色首字母块。发现页
 * 拉目录时把 iconUrl 按 name/slug 记进这里，已安装列表的 SkillGlyph 把它
 * 作为 letter fallback 之前的回退，让同一张卡安装前后图标一致。
 */

/** 市场条目的最小形状（SkillMarketEntry 的子集，避免依赖 rpc 类型）。 */
export interface MarketEntryLike {
	name: string;
	slug: string;
	iconUrl?: string;
}

const normalize = (s: string): string => s.trim().toLowerCase();

/** 已安装判定：市场条目的 name 或 slug 命中已安装名集合即视为已安装。 */
export function marketEntryInstalled(entry: MarketEntryLike, installedNames: ReadonlySet<string>): boolean {
	return installedNames.has(normalize(entry.name)) || installedNames.has(normalize(entry.slug));
}

const iconByKey = new Map<string, string>();

/** 发现页每次拉到目录数据就喂进来：按 name 与 slug 双键记录 iconUrl。 */
export function rememberSkillMarketIcons(entries: readonly MarketEntryLike[]): void {
	for (const e of entries) {
		if (!e.iconUrl) continue;
		iconByKey.set(normalize(e.name), e.iconUrl);
		iconByKey.set(normalize(e.slug), e.iconUrl);
	}
}

/** 已安装列表 SkillGlyph 的回退查询：按技能名取市场图标。 */
export function lookupSkillMarketIcon(name: string): string | undefined {
	return iconByKey.get(normalize(name));
}

/** 测试隔离用：清空图标缓存。 */
export function clearSkillMarketIcons(): void {
	iconByKey.clear();
}
