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
} as const satisfies Record<ContextKey, string>;
