import type { SessionsKey } from "../zh-CN/sessions.js";

export const sessions = {
	// ── Connection & session lifecycle ────────────────────────────────────────
	"room closed": "Room closed",
	"no such room": "No such room",
	"a host is already connected for this room": "A host is already connected for this room",
	"room is full": "Room is full",
	"bad key or corrupted frame": "Bad key or corrupted frame",
	"connection lost (code {code})": "Connection lost (code {code})",
	"timed out waiting for the host's welcome": "Timed out waiting for the host's welcome",
	"timed out waiting for the host's session snapshot": "Timed out waiting for the host's session snapshot",
	"failed to apply session snapshot: {reason}": "Failed to apply session snapshot: {reason}",
	"failed to apply {frame} frame": "Failed to apply {frame} frame",
	"retry {attempt}/{max}: {reason}": "Retry {attempt}/{max}: {reason}",
	"retry failed": "Retry failed",
	"compacting context ({reason})": "Compacting context ({reason})",
	"compaction aborted": "Compaction aborted",
	"compaction failed: {reason}": "Compaction failed: {reason}",
	"context compacted": "Context compacted",

	// ── Relative time ─────────────────────────────────────────────────────────
	now: "Just now",
	"{count}s ago": "{count}s ago",
	"{count}m ago": "{count}m ago",
	"{count}h ago": "{count}h ago",
	"{count}d ago": "{count}d ago",
	"{count}y ago": "{count}y ago",
} as const satisfies Record<SessionsKey, string>;
