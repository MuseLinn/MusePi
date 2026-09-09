import { shellPlatform } from "./electron";

/**
 * Platform-aware shortcut labels. macOS uses ⌘/⇧/⌥ modifiers; Windows and
 * Linux use Ctrl/Shift/Alt. All user-facing shortcut strings should flow
 * through `shortcutLabel` so copy never hardcodes one platform (the
 * welcome tips once said "按 ⌘N 即可开启新会话" on Windows).
 */

export function isMac(): boolean {
	return shellPlatform() === "darwin";
}

/** Primary modifier label: ⌘ on macOS, Ctrl elsewhere. */
export function modLabel(): string {
	return isMac() ? "⌘" : "Ctrl";
}

/**
 * Render a shortcut for the current platform. Pass the macOS form
 * ("⌘N", "⌘⇧E", "⌥⇧F") — on macOS it renders as-is; elsewhere the
 * symbols map to Ctrl/Shift/Alt. Plain letters and non-modifier keys
 * pass through unchanged.
 */
export function shortcutLabel(keys: string): string {
	if (isMac()) return keys;
	return keys.replace("⌘", "Ctrl+").replace("⇧", "Shift+").replace("⌥", "Alt+").replace(/\+$/, "");
}
