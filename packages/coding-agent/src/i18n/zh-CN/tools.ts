export const tools = {
	// ── Tool execution ──────────────────────────────────────
	"tools.text": "（推荐）",
	"tools.recommended": "（推荐）",	"(Recommended)": "（推荐）",

} as const;

/** Key union for the tools domain (mirrors the guest-client locale split). */
export type ToolsKey = keyof typeof tools;
