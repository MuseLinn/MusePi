export const context = {
	// ── Snapcompact savings (context ring popover, TUI /context parity) ──
	"snapcompact savings": "Snapcompact 预计节省",
	"model does not support images": "当前模型不支持图像输入",
	"system prompt imaged: {text} text → {frames} frames (saves ~{saved})":
		"系统提示：{text} 文本 → {frames} 帧（省 ~{saved}）",
	"system prompt stays text ({reason})": "系统提示保持文本（{reason}）",
	"reason: empty": "内容为空",
	"reason: insufficient savings": "节省不足",
	"reason: image budget": "图像预算不足",
	"tool results: {imaged} imaged (saves ~{saved})": "工具结果：{imaged} 个成像（省 ~{saved}）",
	"tool results: none imaged ({total} in history)": "工具结果：未成像（历史 {total} 个）",
	"next request: ~{tokens} tokens on the wire": "下次请求：约 {tokens} tokens",
} as const;

/** Key union for the context domain (source of truth). */
export type ContextKey = keyof typeof context;
