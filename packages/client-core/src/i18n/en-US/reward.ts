import type { RewardKey } from "../zh-CN/reward.js";

export const reward = {
	"reward claim success": "Reward claimed",
	"reward ready desc": "Your reward is ready to use.",
	"reward start": "Start",
	"reward share": "Share",
	"reward replay": "Replay",
} as const satisfies Record<RewardKey, string>;
