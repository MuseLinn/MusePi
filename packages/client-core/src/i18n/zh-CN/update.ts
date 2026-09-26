/**
 * Update UX domain — 应用内更新的 L-dialog 层与 toast 新相位文案
 * （docs/review/0.5.0-installer-update-dialogs-design.md §3，B 面）。
 * 复用 settings 域既有的 "restart now" / "go to download" / "retry" /
 * "download update" 等键，此处只收新增文案。
 */
export const update = {
	// 待重启确认卡（downloaded ≥10min 且 toast 不可见）。
	"update ready title": "更新已就绪",
	"update ready body": "新版本 {version} 已下载完成，重启应用即可完成安装。",
	// 失败决策卡标题（download/install 连续失败 ≥2 次）。
	"update failed title download": "更新下载失败",
	"update failed title install": "更新安装失败",
	// 失败分类语义文案（kind → 文案，主进程只发稳定枚举）。
	"update error check": "检查更新失败。",
	"update error check-network": "检查更新失败：网络不可用或无法连接更新服务器。",
	"update error download": "下载更新失败。",
	"update error download-network": "下载更新失败：网络中断或不稳定，可稍后重试。",
	"update error install": "安装更新失败。",
	"update error install-network": "安装更新失败：无法连接更新服务器。",
	// 错误详情折叠（原始 message + 技术栈）。
	"technical details": "技术详情",
	// 失败决策卡次按钮（Escape）。
	"update later": "暂不",
	// quitAndInstall 宽限期内 toast/弹窗的不可点文案（§3.3-3）。
	"installing update": "正在安装更新，安装完成后将自动重启",
	// 下载末段相位文案（§3.3-1 阶梯语义）。
	"preparing update": "正在准备更新…",
	"verifying update": "正在校验安装包…",
} as const;

/** Key union for the update domain (source of truth). */
export type UpdateKey = keyof typeof update;
