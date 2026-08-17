export const sessions = {
	// ── Connection & session lifecycle ────────────────────────────────────────
	"room closed": "房间已关闭",
	"no such room": "房间不存在",
	"a host is already connected for this room": "该房间已有宿主连接",
	"room is full": "房间已满",
	"bad key or corrupted frame": "密钥错误或帧已损坏",
	"connection lost (code {code})": "连接断开（代码 {code}）",
	"timed out waiting for the host's welcome": "等待宿主欢迎超时",
	"timed out waiting for the host's session snapshot": "等待宿主会话快照超时",
	"failed to apply session snapshot: {reason}": "应用会话快照失败：{reason}",
	"failed to apply {frame} frame": "应用 {frame} 帧失败",
	"retry {attempt}/{max}: {reason}": "重试 {attempt}/{max}：{reason}",
	"retry failed": "重试失败",
	"compacting context ({reason})": "正在压缩上下文（{reason}）",
	"compaction aborted": "压缩已中止",
	"compaction failed: {reason}": "压缩失败：{reason}",
	"context compacted": "上下文已压缩",

	// ── Relative time ─────────────────────────────────────────────────────────
	now: "刚刚",
	"{count}s ago": "{count} 秒前",
	"{count}m ago": "{count} 分钟前",
	"{count}h ago": "{count} 小时前",
	"{count}d ago": "{count} 天前",
	"{count}y ago": "{count} 年前",
} as const;

/** Key union for the sessions domain (source of truth). */
export type SessionsKey = keyof typeof sessions;
