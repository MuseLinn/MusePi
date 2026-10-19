/** 奖励卡片域 — 周年庆/活动票券弹窗（RewardOverlay）的兜底文案。
 *  活动内容（品牌、数额、有效期）来自 daemon reward.json 载荷，
 *  这里只承载结构固定的兜底与操作词。 */
export const reward = {
	"reward.rewardClaimSuccess": "领取成功",
	"reward.rewardReadyDesc": "奖励已准备好，可以开始使用。",
	"reward.rewardStart": "开始体验",
	"reward.rewardShare": "分享",
	"reward.rewardReplay": "重放动画",
} as const;

export type RewardKey = keyof typeof reward;
