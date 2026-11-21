import type { MarketplaceKey } from "../zh-CN/marketplace.js";

export const marketplace = {
	"marketplace.versions": "Versions",
	"marketplace.versionCurrent": "Current",
	"marketplace.versionDowngradeBlocked": "The installed version is newer — downgrades are not supported",
	"marketplace.upgradeToVersion": "Upgrade to v{version}",
	"marketplace.replaceConfirm":
		"{name} now ships from “{source}”, a different source than the installed copy. Reinstall v{version} from there?",
} as const satisfies Record<MarketplaceKey, string>;
