/**
 * Shared formatting helpers for search results.
 */

/**
 * Convert a Date or ISO string to "age in seconds". Returns undefined for
 * unset dates.
 */
export function dateToAgeSeconds(date: Date | string | undefined): number | undefined {
	if (!date) return undefined;
	const d = typeof date === "string" ? new Date(date) : date;
	return Math.floor((Date.now() - d.getTime()) / 1000);
}

/**
 * Clamp the number of results to a valid range [1, max].
 */
export function clampNumResults(requested: number | undefined, max = 10): number {
	if (!requested || requested < 1) return 5;
	return Math.min(requested, max);
}

/**
 * Truncate text to a max length (appending "…" when truncated).
 */
export function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen)}\u2026`;
}
