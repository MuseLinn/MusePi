/**
 * Capacitor shell detection + native chrome wiring for the mobile entry.
 *
 * The desktop web entry never imports this module, so the Capacitor globals
 * stay out of the browser bundle. `isNativeShell()` is the single source of
 * truth for "are we inside the Android/iOS WebView?" — everything else that
 * needs to know (connect screen QR, notification permission, back button)
 * asks here instead of re-probing `window.Capacitor` inline.
 *
 * Native plugins are reached through their JS modules (`await import()`,
 * platform-specific modules that only exist in the shell build) — NOT
 * `window.Capacitor.plugins` (lowercase), which is not populated on real
 * Android WebViews; the runtime registry is `window.Capacitor.Plugins`
 * (capital P) and only lists JS-imported plugin modules anyway.
 */

declare global {
	interface Window {
		Capacitor?: {
			plugins?: {
				Keyboard?: {
					removeAllListeners: () => Promise<void>;
					addListener: (eventName: string, cb: (info: { keyboardHeight: number }) => void) => Promise<unknown>;
				};
				LocalNotifications?: unknown;
			};
		};
	}
}

/** True inside the Capacitor WebView (native bridge present). */
export function isNativeShell(): boolean {
	return typeof window !== "undefined" && window.Capacitor != null;
}

/**
 * DOM event dispatched when the Android system back key is pressed. The
 * shell component stack listens and calls `preventDefault()` when a layer
 * consumed the press; if nobody handles it, the app exits (native default).
 * `cancelable` lets dispatchEvent() report consumption via its return value.
 */
export const BACK_EVENT = "musepi:back";

/**
 * Wire the Android hardware back key to the app's layer stack.
 *
 * Capacitor's default back behavior pops WebView history and eventually
 * finishes the activity — which would exit the app with the agents rail,
 * a panel, or the agent drawer still open. Instead: dispatch BACK_EVENT; if
 * a layer consumed it (dispatchEvent returns false), stop here. Otherwise
 * pop hash history (deep-link entries) first, then exit.
 *
 * Desktop web never calls this — browsers keep their own history semantics.
 */
export async function setupAndroidBackHandler(): Promise<void> {
	if (!isNativeShell()) return;
	// Platform-specific module: the App plugin only exists in the shell —
	// static import would pull it into the desktop web bundle (and it is not
	// part of the desktop-web dependency tree's runtime surface).
	const { App } = await import("@capacitor/app");
	void App.addListener("backButton", ({ canGoBack }) => {
		const event = new CustomEvent(BACK_EVENT, { cancelable: true });
		const consumed = !window.dispatchEvent(event);
		if (consumed) return;
		if (canGoBack) {
			window.history.back();
		} else {
			void App.exitApp();
		}
	});
}
