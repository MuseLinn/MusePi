import type { UpdateKey } from "../zh-CN/update.js";

export const update = {
	// 待重启确认卡（downloaded ≥10min 且 toast 不可见）。
	"update ready title": "Update ready",
	"update ready body": "Version {version} has been downloaded — restart the app to finish installing.",
	// 失败决策卡标题（download/install 连续失败 ≥2 次）。
	"update failed title download": "Update download failed",
	"update failed title install": "Update install failed",
	// 失败分类语义文案（kind → 文案，主进程只发稳定枚举）。
	"update error check": "Checking for updates failed.",
	"update error check-network":
		"Checking for updates failed — the network is unavailable or the update server cannot be reached.",
	"update error download": "Downloading the update failed.",
	"update error download-network":
		"Downloading the update failed — the network dropped or is unstable. Try again later.",
	"update error install": "Installing the update failed.",
	"update error install-network": "Installing the update failed — the update server cannot be reached.",
	// 错误详情折叠（原始 message + 技术栈）。
	"technical details": "Technical details",
	// 失败决策卡次按钮（Escape）。
	"update later": "Later",
	// quitAndInstall 宽限期内 toast/弹窗的不可点文案（§3.3-3）。
	"installing update": "Installing the update — the app will restart automatically when done",
	// 下载末段相位文案（§3.3-1 阶梯语义）。
	"preparing update": "Preparing update…",
	"verifying update": "Verifying package…",
} as const satisfies Record<UpdateKey, string>;
