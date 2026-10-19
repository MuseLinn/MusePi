import type { AnnouncementKey } from "../zh-CN/announcement.js";

export const announcement = {
	"announcement.updatedToVersionWithVersion": "MusePi updated to v{version}",
	"announcement.moreFixesWithCount": "{count} more fixes and improvements in this release",
	"announcement.olderReleases": "Older releases",
	"announcement.changesWithCount": "{count} changes",
	"announcement.viewFullChangelog": "View full changelog",
} as const satisfies Record<AnnouncementKey, string>;
