/**
 * Pure keyboard-navigation stepper for the address-bar suggestion list
 * (ManagedBrowserPane onAddressKeyDown). Mirrors openchamber BrowserToolbar:
 * ArrowDown/ArrowUp walk the options and wrap through "nothing selected"
 * (-1) in both directions, so the typed address stays reachable with one
 * extra keystroke past either end.
 */
export type SuggestionStepKey = "ArrowDown" | "ArrowUp";

/**
 * Returns the next highlighted index. `-1` means "no highlight" — the state
 * the typed-but-unselected address sits in; Enter then falls through to the
 * input's own submit instead of a suggestion.
 */
export function stepSuggestionIndex(current: number, key: SuggestionStepKey, count: number): number {
	if (count <= 0) return -1;
	const step = key === "ArrowDown" ? 1 : -1;
	const next = current + step;
	if (next < -1) return count - 1;
	if (next >= count) return -1;
	return next;
}
