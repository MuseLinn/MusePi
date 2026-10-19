import type { RewardKey } from "../zh-CN/reward.js";

export const reward = {
	"reward.rewardClaimSuccess": "Reward claimed",
	"reward.rewardReadyDesc": "Your reward is ready to use.",
	"reward.rewardStart": "Start",
	"reward.rewardShare": "Share",
	"reward.rewardReplay": "Replay",
} as const satisfies Record<RewardKey, string>;
