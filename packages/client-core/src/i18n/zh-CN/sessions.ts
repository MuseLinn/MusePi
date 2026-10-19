export const sessions = {
	// ── Connection & session lifecycle ────────────────────────────────────────
	"sessions.roomClosed": "房间已关闭",
	"sessions.noSuchRoom": "房间不存在",
	"sessions.hostAlreadyConnectedRoom": "该房间已有宿主连接",
	"sessions.roomFull": "房间已满",
	"sessions.badKeyCorruptedFrame": "密钥错误或帧已损坏",
	"sessions.connectionLostWithCode": "连接断开（代码 {code}）",
	"sessions.timedOutWaitingHost": "等待宿主欢迎超时",
	"sessions.timedOutWaitingHostSSession": "等待宿主会话快照超时",
	"sessions.failedApplySessionSnapshotWithReason": "应用会话快照失败：{reason}",
	"sessions.failedApplyFrameWithFrame": "应用 {frame} 帧失败",
	"sessions.retryWithAttemptWithMaxWithReason": "重试 {attempt}/{max}：{reason}",
	"sessions.retryFailed": "重试失败",
	"sessions.compactingContextWithReason": "正在压缩上下文（{reason}）",
	"sessions.compactionAborted": "压缩已中止",
	"sessions.compactionFailedWithReason": "压缩失败：{reason}",
	"sessions.contextCompacted": "上下文已压缩",

	// ── Relative time ─────────────────────────────────────────────────────────
	"sessions.now": "刚刚",
	"sessions.sAgoWithCount": "{count} 秒前",
	"sessions.mAgoWithCount": "{count} 分钟前",
	"sessions.hAgoWithCount": "{count} 小时前",
	"sessions.dAgoWithCount": "{count} 天前",
	"sessions.yAgoWithCount": "{count} 年前",

	// ── Lifecycle status (sidebar row's left square tooltip / a11y) ──────────
	"sessions.sessionStatusComplete": "已完成",
	"sessions.sessionStatusInterrupted": "已中断",
	"sessions.sessionStatusAborted": "已中止",
	"sessions.sessionStatusError": "出错",
	"sessions.sessionStatusPending": "处理中",
	"sessions.sessionStatusUnknown": "未知状态",
} as const;

/** Key union for the sessions domain (source of truth). */
export type SessionsKey = keyof typeof sessions;
