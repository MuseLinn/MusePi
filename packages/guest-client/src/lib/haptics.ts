/**
 * Light vibration for key interactions in the Capacitor shell.
 *
 * Calls `navigator.vibrate()` when available (Android WebView, some mobile
 * browsers). Desktop web and reduced-motion users skip silently. The API is
 * best-effort — no permission prompt, no error surfaced.
 */

/** Reduced-motion opt-out (vibration is a physical sensation, not motion,
 *  but the conservative choice matches the mobile design doc principle of
 *  "skip all non-essential sensory feedback when prefers-reduced-motion"). */
function prefersReducedMotion(): boolean {
	try {
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	} catch {
		return false;
	}
}

/** Trigger a single vibration pulse or a pattern. Desktop web and
 *  reduced-motion no-op silently. */
export function haptic(pattern: number | readonly number[]): void {
	if (prefersReducedMotion()) return;
	try {
		if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
			navigator.vibrate(pattern as number | number[]);
		}
	} catch {
		// API unavailable (iOS Safari, permission-blocked) — silent.
	}
}
