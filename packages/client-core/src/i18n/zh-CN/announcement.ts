/** 新功能面板窄域 — what's-new 结构化亮点卡（AnnouncementOverlay）的固定文案。
 *  changelog 内容本身来自 daemon 的 markdown 载荷，不在此列；
 *  「知道了」等沿用 settings 域既有 key。 */
export const announcement = {
	"MusePi updated to v{version}": "MusePi 更新到 v{version}",
	"{count} more fixes and improvements": "本次还有 {count} 项修复与改进",
	"older releases": "更多版本",
	"{count} changes": "{count} 项变更",
	"view full changelog": "查看完整日志",
} as const;

export type AnnouncementKey = keyof typeof announcement;
