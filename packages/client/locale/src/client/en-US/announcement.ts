import type { AnnouncementKey } from "../zh-CN/announcement.js";

export const announcement = {
	"announcement.announcementUpdatedtoversionwithversion": "MusePi updated to v{version}",
	"announcement.announcementMorefixeswithcount": "{count} more fixes and improvements in this release",
	"announcement.announcementOlderreleases": "Older releases",
	"announcement.announcementChangeswithcount": "{count} changes",
	"announcement.announcementViewfullchangelog": "View full changelog",
} as const satisfies Record<AnnouncementKey, string>;
