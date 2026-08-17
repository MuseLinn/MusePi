/**
 * GUI-native /usage command detection. Typing /usage in the composer shows
 * the structured quota panel instead of sending the command to the agent
 * (whose reply is TUI panel ANSI text that never parses cleanly).
 */
export function isUsageCommand(text: string): boolean {
	const trimmed = text.trim();
	return trimmed === "/usage" || trimmed.startsWith("/usage ");
}
