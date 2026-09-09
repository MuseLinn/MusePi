import type { ContextKey } from "../zh-CN/context.js";

export const context = {
	// ── Snapcompact savings (context ring popover, TUI /context parity) ──
	"snapcompact savings": "Snapcompact savings",
	"model does not support images": "Model does not support images",
	"system prompt imaged: {text} text → {frames} frames (saves ~{saved})":
		"System prompt imaged: {text} text → {frames} frames (saves ~{saved})",
	"system prompt stays text ({reason})": "System prompt stays text ({reason})",
	"reason: empty": "Reason: empty",
	"reason: insufficient savings": "Reason: insufficient savings",
	"reason: image budget": "Reason: image budget",
	"tool results: {imaged} imaged (saves ~{saved})": "Tool results: {imaged} imaged (saves ~{saved})",
	"tool results: none imaged ({total} in history)": "Tool results: none imaged ({total} in history)",
	"next request: ~{tokens} tokens on the wire": "Next request: ~{tokens} tokens on the wire",
} as const satisfies Record<ContextKey, string>;
