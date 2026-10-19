export const context = {
	// ── Snapcompact savings (context ring popover, TUI /context parity) ──
	"context.snapcompactSavings": "Snapcompact 预计节省",
	"context.modelDoesNotSupport": "当前模型不支持图像输入",
	"context.systemPromptImagedTextWithTextWithFramesWithSaved":
		"系统提示：{text} 文本 → {frames} 帧（省 ~{saved}）",
	"context.systemPromptStaysTextWithReason": "系统提示保持文本（{reason}）",
	"context.reasonEmpty": "内容为空",
	"context.reasonInsufficientSavings": "节省不足",
	"context.reasonImageBudget": "图像预算不足",
	"context.toolResultsImagedWithImagedWithSaved": "工具结果：{imaged} 个成像（省 ~{saved}）",
	"context.toolResultsNoneImagedWithTotal": "工具结果：未成像（历史 {total} 个）",
	"context.nextRequestTokensWithTokens.info": "下次请求：约 {tokens} tokens",
} as const;

/** Key union for the context domain (source of truth). */
export type ContextKey = keyof typeof context;
