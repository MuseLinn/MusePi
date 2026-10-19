export const shell = {
	// ── Connect screen ────────────────────────────────────────────────────────
	"shell.musepiCollab": "musepi 协作",
	"shell.liveAgentSession.info": "浏览器中的实时代理会话",
	"shell.joinLink": "加入链接",
	"shell.displayName": "显示名称",
	"shell.pasteJoinLinkFirst": "请先粘贴加入链接",
	"shell.pasteCollabLinkAny": "从任意 musepi 会话粘贴 /collab 链接",
	"shell.wsHostPortR": "ws://主机:端口/r/房间密钥",

	// ── Header bar ────────────────────────────────────────────────────────────
	"shell.readOnly": "只读",
	"shell.readOnlyLinkWatching": "只读链接 — 仅观看",
	"shell.contextWithPct": "上下文 · {pct}",
	"shell.hideAgents": "隐藏代理",
	"shell.showAgents": "显示代理",
	"shell.leaveSession": "离开会话",
	"shell.connectingRelay": "正在连接中继…",
	"shell.joiningSession": "正在加入会话…",
	"shell.reconnecting": "正在重连…",
	"shell.sessionEnded": "会话已结束",
	"shell.showMainWindow": "显示主窗",
	"shell.quit": "退出",
	"shell.newLink": "新链接",

	// ── Banners ───────────────────────────────────────────────────────────────

	// ── Theme toggle ──────────────────────────────────────────────────────────
	"shell.systemTheme": "跟随系统",
	"shell.lightTheme": "浅色主题",
	"shell.darkTheme": "深色主题",
	"shell.text": "{name}（点击切换）",
	"shell.clickSwitchWithName": "{name} — 点击切换",

	// ── Accent toggle ─────────────────────────────────────────────────────────
	"shell.brandGold": "品牌金",
	"shell.monochrome": "单色",
	"shell.oceanBlue": "海洋蓝",
	"shell.jadeGreen": "翡翠绿",
	"shell.clickForWithName": "点击切换为{name}",
	"shell.approvalNeeded": "需要审批",
	"shell.approveTool": "允许",
	"shell.denyTool": "拒绝",
	"shell.waitingYourDecision": "等待你的决定",
} as const;

/** Key union for the shell domain (source of truth). */
export type ShellKey = keyof typeof shell;
