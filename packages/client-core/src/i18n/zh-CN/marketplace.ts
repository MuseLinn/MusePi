/**
 * Marketplace domain — 插件详情页的版本选择与跨仓重装确认。
 * 升级/全部升级/升级确认等既有键仍在 guest 域（多处在用，语义未变），
 * 此处只收本次新增文案。
 */
export const marketplace = {
	"marketplace.versions": "可用版本",
	"marketplace.versionCurrent": "当前",
	"marketplace.versionDowngradeBlocked": "已装版本更新，不支持降级",
	"marketplace.upgradeToVersion": "升级到 v{version}",
	"marketplace.replaceConfirm": "{name} 现在来自 “{source}”，与已装副本不是同一来源。要从那里重新安装 v{version} 吗？",
} as const;

/** Key union for the marketplace domain (source of truth). */
export type MarketplaceKey = keyof typeof marketplace;
