import type { UpdateKey } from "../zh-CN/update.js";

export const update = {
	// 待重启确认卡（downloaded ≥10min 且 toast 不可见）。
	"update.updateReadyTitle": "Update ready",
	"update.updateReadyBody": "Version {version} has been downloaded — restart the app to finish installing.",
	// 失败决策卡标题（download/install 连续失败 ≥2 次）。
	"update.updateFailedTitleDownload": "Update download failed",
	"update.updateFailedTitleInstall": "Update install failed",
	// 失败分类语义文案（kind → 文案，主进程只发稳定枚举）。
	"update.updateErrorCheck": "Checking for updates failed.",
	"update.updateErrorCheckNetwork":
		"Checking for updates failed — the network is unavailable or the update server cannot be reached.",
	"update.updateErrorDownload": "Downloading the update failed.",
	"update.updateErrorDownloadNetwork":
		"Downloading the update failed — the network dropped or is unstable. Try again later.",
	"update.updateErrorInstall": "Installing the update failed.",
	"update.updateErrorInstallNetwork": "Installing the update failed — the update server cannot be reached.",
	// 错误详情折叠（原始 message + 技术栈）。
	"update.technicalDetails": "Technical details",
	// 失败决策卡次按钮（Escape）。
	"update.updateLater": "Later",
	// quitAndInstall 宽限期内 toast/弹窗的不可点文案（§3.3-3）。
	"update.installingUpdate": "Installing the update — the app will restart automatically when done",
	// Idle handoff after the download: the main process ships counts and stable
	// reason ids only; wording lives here.
	"update.restartWaitingWithCount": "{count} request(s) still running — restarting when they complete",
	"update.restartWaiting": "Work is still running — restarting when it completes",
	"update.restartWaitingUnavailable": "Temporarily unable to confirm the app is idle — restarting once it can",
	"update.restartImminent": "No work left — restarting to finish the update…",
	"update.restartBlockedScheduled": "{count} scheduled reminder(s) armed — automatic restart paused",
	"update.restartBlockedBusy": "A session started running again — automatic restart paused",
	"update.restartBlockedUnavailable": "Could not confirm the app is idle — automatic restart paused",
	"update.restartBlockedFailed": "The last restart did not complete — try again",
	// 下载末段相位文案（§3.3-1 阶梯语义）。
	"update.preparingUpdate": "Preparing update…",
	"update.verifyingUpdate": "Verifying package…",
	"update ready title": "update ready title",
	"update ready body": "update ready body",
	"update failed title download": "update failed title download",
	"update failed title install": "update failed title install",
	"update error check": "update error check",
	"update error check-network": "update error check-network",
	"update error download": "update error download",
	"update error download-network": "update error download-network",
	"update error install": "update error install",
	"update error install-network": "update error install-network",
	"technical details": "technical details",
	"update later": "update later",
	"installing update": "installing update",
	"preparing update": "preparing update",
	"verifying update": "verifying update",
} as const satisfies Record<UpdateKey, string>;
