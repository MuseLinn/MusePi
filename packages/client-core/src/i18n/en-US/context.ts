import type { ContextKey } from "../zh-CN/context.js";

export const context = {
	// ── Snapcompact savings (context ring popover, TUI /context parity) ──
	"context.snapcompactSavings": "Snapcompact savings",
	"context.modelDoesNotSupport": "Model does not support images",
	"context.systemPromptImagedTextWithTextWithFramesWithSaved":
		"System prompt imaged: {text} text → {frames} frames (saves ~{saved})",
	"context.systemPromptStaysTextWithReason": "System prompt stays text ({reason})",
	"context.reasonEmpty": "Reason: empty",
	"context.reasonInsufficientSavings": "Reason: insufficient savings",
	"context.reasonImageBudget": "Reason: image budget",
	"context.toolResultsImagedWithImagedWithSaved": "Tool results: {imaged} imaged (saves ~{saved})",
	"context.toolResultsNoneImagedWithTotal": "Tool results: none imaged ({total} in history)",
	"context.nextRequestTokensWithTokens.info": "Next request: ~{tokens} tokens on the wire",
	"snapcompact savings": "snapcompact savings",
	"model does not support images": "model does not support images",
	"system prompt imaged: {text} text → {frames} frames (saves ~{saved})":
		"system prompt imaged: {text} text → {frames} frames (saves ~{saved})",
	"system prompt stays text ({reason})": "system prompt stays text ({reason})",
	"reason: empty": "reason: empty",
	"reason: insufficient savings": "reason: insufficient savings",
	"reason: image budget": "reason: image budget",
	"tool results: {imaged} imaged (saves ~{saved})": "tool results: {imaged} imaged (saves ~{saved})",
	"tool results: none imaged ({total} in history)": "tool results: none imaged ({total} in history)",
	"next request: ~{tokens} tokens on the wire": "next request: ~{tokens} tokens on the wire",
} as const satisfies Record<ContextKey, string>;
