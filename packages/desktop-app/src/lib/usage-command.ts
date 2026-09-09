/**
 * GUI-native /usage command detection. Typing /usage in the composer shows
 * the structured quota panel instead of sending the command to the agent
 * (whose reply is TUI panel ANSI text that never parses cleanly).
 */
export function isUsageCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/usage" || trimmed.startsWith("/usage ");
}

/** GUI-native /autoresearch: show the experiment dashboard panel instead
 *  of sending the command to the agent (TUI widget/overlay parity). */
export function isAutoresearchCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/autoresearch" || trimmed.startsWith("/autoresearch ");
}

/** GUI-native /debug: show the diagnostics panel instead of sending the
 *  command to the agent (the TUI /debug menu is TUI-only — session.slashCommand
 *  reports it "tui-only", so the GUI intercepts it like /usage). */
export function isDebugCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/debug" || trimmed.startsWith("/debug ");
}
