import type { SessionsKey } from "../zh-CN/sessions.js";

export const sessions = {
	// ── Connection & session lifecycle ────────────────────────────────────────
	"sessions.roomClosed": "Room closed",
	"sessions.noSuchRoom": "No such room",
	"sessions.hostAlreadyConnectedRoom": "A host is already connected for this room",
	"sessions.roomFull": "Room is full",
	"sessions.badKeyCorruptedFrame": "Bad key or corrupted frame",
	"sessions.connectionLostWithCode": "Connection lost (code {code})",
	"sessions.timedOutWaitingHost": "Timed out waiting for the host's welcome",
	"sessions.timedOutWaitingHostSSession": "Timed out waiting for the host's session snapshot",
	"sessions.failedApplySessionSnapshotWithReason": "Failed to apply session snapshot: {reason}",
	"sessions.failedApplyFrameWithFrame": "Failed to apply {frame} frame",
	"sessions.retryWithAttemptWithMaxWithReason": "Retry {attempt}/{max}: {reason}",
	"sessions.retryFailed": "Retry failed",
	"sessions.compactingContextWithReason": "Compacting context ({reason})",
	"sessions.compactionAborted": "Compaction aborted",
	"sessions.compactionFailedWithReason": "Compaction failed: {reason}",
	"sessions.contextCompacted": "Context compacted",

	// ── Relative time ─────────────────────────────────────────────────────────
	"sessions.now": "Just now",
	"sessions.sAgoWithCount": "{count}s ago",
	"sessions.mAgoWithCount": "{count}m ago",
	"sessions.hAgoWithCount": "{count}h ago",
	"sessions.dAgoWithCount": "{count}d ago",
	"sessions.yAgoWithCount": "{count}y ago",

	// ── Lifecycle status (sidebar row's left square tooltip / a11y) ──────────
	"sessions.sessionStatusComplete": "Complete",
	"sessions.sessionStatusInterrupted": "Interrupted",
	"sessions.sessionStatusAborted": "Aborted",
	"sessions.sessionStatusError": "Error",
	"sessions.sessionStatusPending": "Pending",
	"sessions.sessionStatusUnknown": "Unknown",
} as const satisfies Record<SessionsKey, string>;
