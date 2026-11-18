/**
 * Which surface is rendering the client.
 *
 * Three answers exist because three different questions keep getting
 * conflated:
 *
 * - `isMobileShell()` (lib/capacitor) — is there a native shell around this
 *   page? Capacitor and ArkWeb both answer yes. This is the question native
 *   chrome asks: the keyboard plugin, `env(safe-area-inset-*)` fallbacks,
 *   status-bar painting, haptics, local notifications.
 * - `isMobileSurface()` here — should the page present the phone-shaped
 *   information architecture (bottom destinations, draft-first session flow,
 *   touch-sized targets)? A phone or tablet browser answers yes even though
 *   nothing native surrounds it. A narrow desktop window answers no: the
 *   pointer is fine, and dragging a window edge must not delete the desktop
 *   workspace directory.
 * - `hasNativeKeyboard()` — who owns the soft-keyboard inset. Only the native
 *   shells do (they run `resize: "none"` and report the IME height); a browser
 *   shrinks its visual viewport instead, so compensating there as well lifts
 *   the composer by a second keyboard height.
 *
 * The touch test is the primary-pointer media query, not the user agent: a
 * tablet with a trackpad and a touchscreen laptop both report `fine`, and both
 * are desktop-shaped surfaces. The width guard keeps a large tablet in
 * landscape on the multi-column layout, where the rail already carries every
 * destination and a floating bar would only cover the transcript.
 */

import { isMobileShell } from "./capacitor";

/**
 * No hovering capability — the honest finger-first signal.
 *
 * `(pointer: coarse)` is NOT the right test: on a foldable (or any laptop
 * with a touchscreen) the PRIMARY pointer is the trackpad, so the browser
 * reports `fine` while the screen still has no hover. Measured on a Huawei
 * Pura X Max: `hover: none` true, `pointer: coarse` false, `innerWidth` 940.
 * `hover: none` is what "you cannot hover here" actually means.
 */
const NO_HOVER = "(hover: none)";

/**
 * Widest viewport that still reads as a phone-shaped surface (CSS px).
 *
 * A foldable opened up reports ~940 CSS px, so the phone IA has to survive
 * past the old 840 cut — otherwise the same page shows the phone layout in
 * the shell and the desktop layout in a browser.
 */
const PHONE_MAX_WIDTH = 1100;

function mediaMatches(query: string): boolean {
	return typeof window !== "undefined" && window.matchMedia?.(query).matches === true;
}

/**
 * True on a finger-first screen in the phone/tablet size range.
 *
 * The width bound is what keeps a narrow DESKTOP window on the desktop
 * layout: dragging an editor window narrow must not delete the workspace
 * directory. The touch signal alone cannot carry that distinction — a
 * touchscreen laptop reports no-hover too.
 */
export function isTouchSurface(): boolean {
	if (typeof window === "undefined") return false;
	return mediaMatches(NO_HOVER) && window.innerWidth < PHONE_MAX_WIDTH;
}

/**
 * True when the page should present the phone information architecture:
 * a native mobile shell, or a touch-first browser narrow enough to need it.
 */
export function isMobileSurface(): boolean {
	return isMobileShell() || isTouchSurface();
}

/**
 * True when the shell around the page owns the soft-keyboard inset, i.e. the
 * page must NOT also compensate from the visual viewport.
 */
export function hasNativeKeyboard(): boolean {
	return isMobileShell();
}

/**
 * True when this page can drive the camera scanner itself.
 *
 * `getUserMedia` is a web capability, not a native one, so gating the scan
 * entry on `isMobileShell()` hid it from phone browsers that have a perfectly
 * working camera and showed it inside shells that may refuse the permission.
 * The two real requirements are a secure context (the relay serves HTTPS, or
 * localhost) and a camera-backed `getUserMedia`.
 */
export function canScanQr(): boolean {
	if (typeof window === "undefined" || typeof navigator === "undefined") return false;
	return window.isSecureContext === true && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/**
 * Subscribe to surface changes. Rotation, folding, an attached keyboard and a
 * resized window all move this answer, and the listener list is the same two
 * queries `isTouchSurface` reads.
 */
export function subscribeSurfaceChange(listener: () => void): () => void {
	if (typeof window === "undefined" || !window.matchMedia) return () => {};
	const queries = [NO_HOVER, `(max-width: ${PHONE_MAX_WIDTH - 1}px)`].map(query => window.matchMedia(query));
	for (const query of queries) query.addEventListener("change", listener);
	window.addEventListener("resize", listener);
	window.addEventListener("orientationchange", listener);
	return () => {
		for (const query of queries) query.removeEventListener("change", listener);
		window.removeEventListener("resize", listener);
		window.removeEventListener("orientationchange", listener);
	};
}
