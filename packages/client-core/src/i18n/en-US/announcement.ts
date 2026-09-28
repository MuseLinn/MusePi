import type { AnnouncementKey } from "../zh-CN/announcement.js";

export const announcement = {
	"MusePi updated to v{version}": "MusePi updated to v{version}",
	"{count} more fixes and improvements": "{count} more fixes and improvements in this release",
	"older releases": "Older releases",
	"{count} changes": "{count} changes",
	"view full changelog": "View full changelog",
} as const satisfies Record<AnnouncementKey, string>;
