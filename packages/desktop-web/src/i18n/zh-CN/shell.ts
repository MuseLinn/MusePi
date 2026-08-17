export const shell = {
	// ── Connect screen ────────────────────────────────────────────────────────
	"musepi collab": "musepi 协作",
	"live agent session, in your browser": "浏览器中的实时代理会话",
	"join link": "加入链接",
	"display name": "显示名称",
	"paste a join link first": "请先粘贴加入链接",
	"paste a /collab link from any musepi session": "从任意 musepi 会话粘贴 /collab 链接",
	"ws://host:port/r/room.key": "ws://主机:端口/r/房间密钥",

	// ── Header bar ────────────────────────────────────────────────────────────
	"read-only": "只读",
	"read-only link — watching only": "只读链接 — 仅观看",
	"context · {pct}": "上下文 · {pct}",
	"hide agents": "隐藏代理",
	"show agents": "显示代理",
	"leave session": "离开会话",
	"connecting to relay…": "正在连接中继…",
	"joining session…": "正在加入会话…",
	"reconnecting…": "正在重连…",
	"session ended": "会话已结束",
	"show main window": "显示主窗",
	quit: "退出",
	"New link": "新链接",

	// ── Banners ───────────────────────────────────────────────────────────────

	// ── Theme toggle ──────────────────────────────────────────────────────────
	"System theme": "跟随系统",
	"Light theme": "浅色主题",
	"Dark theme": "深色主题",
	"{name} (click to switch)": "{name}（点击切换）",
	"{name} — click to switch": "{name} — 点击切换",

	// ── Accent toggle ─────────────────────────────────────────────────────────
	"Brand pink": "品牌粉",
	Monochrome: "单色",
	"Ocean blue": "海洋蓝",
	"Jade green": "翡翠绿",
	"click for {name}": "点击切换为{name}",
} as const;

/** Key union for the shell domain (source of truth). */
export type ShellKey = keyof typeof shell;
