export const tools = {
	// ── Tool execution ──────────────────────────────────────
	"(Recommended)": "（推荐）",
} as const;

/** Key union for the tools domain (mirrors the desktop-web locale split). */
export type ToolsKey = keyof typeof tools;
