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
 *
 * HarmonyOS WebView shell uses the same module but routes through
 * `window.harmonyNative` (ArkTS javaScriptProxy) instead of Capacitor.
 * `isMobileShell()` returns true for either shell.
 */

import { dispatchBack } from "./back-stack";

declare global {
	interface Window {
		Capacitor?: {
			/** Low-level bridge: call a native-registered plugin by name. */
			nativePromise?: <T = unknown>(
				pluginName: string,
				methodName: string,
				options?: Record<string, unknown>,
			) => Promise<T>;
			plugins?: {
				Keyboard?: {
					removeAllListeners: () => Promise<void>;
					addListener: (eventName: string, cb: (info: { keyboardHeight: number }) => void) => Promise<unknown>;
				};
				LocalNotifications?: unknown;
			};
			// Runtime registry of registered plugins (capital P). The
			// lowercase `plugins` above is a legacy declaration that is never
			// populated on real Android WebViews; reach plugins through the
			// JS modules or this registry instead.
			Plugins?: {
				Insets?: {
					getSystemBars: () => Promise<{ top: number; bottom: number }>;
				};
				Badge?: {
					get: () => Promise<{ count: number }>;
					set: (o: { count: number }) => Promise<void>;
					clear: () => Promise<void>;
				};
			};
		};
		/**
		 * HarmonyOS WebView shell bridge — the ArkTS javaScriptProxy object
		 * named `harmonyNative`. Methods are synchronous and return JSON
		 * strings (JavaProxy contract). Injected by the shell's
		 * Web({ javaScriptProxy }) and absent in browsers.
		 */
		harmonyNative?: {
			getSystemBars: () => string;
			getBadge: () => string;
			setBadgeCount: (count: number) => void;
			clearBadge: () => void;
			consumeDeepLink: () => string;
		};
	}
}

/** True inside the Capacitor WebView (native bridge present). */
export function isNativeShell(): boolean {
	return typeof window !== "undefined" && window.Capacitor != null;
}

/** True inside the HarmonyOS WebView shell (ArkTS javaScriptProxy present). */
export function isHarmonyShell(): boolean {
	return typeof window !== "undefined" && window.harmonyNative != null;
}

/** True in any mobile shell (Capacitor or HarmonyOS WebView). */
export function isMobileShell(): boolean {
	return isNativeShell() || isHarmonyShell();
}

/**
 * Wire the Android hardware back key to the app's layer stack.
 *
 * Capacitor's default back behavior pops WebView history and eventually
 * finishes the activity — which would exit the app with the agents rail,
 * a panel, or the agent drawer still open. Instead: dispatch through the
 * shared layer stack (`dispatchBack` in ./back-stack); if a layer consumed
 * the press, stop here. Otherwise pop hash history (deep-link entries)
 * first, then exit.
 *
 * Desktop web never calls this — browsers keep their own history semantics.
 * HarmonyOS shell: back is handled in ArkTS onBackPress -> accessStep().
 */
export async function setupAndroidBackHandler(): Promise<void> {
	if (!isNativeShell()) return;
	// Platform-specific module: the App plugin only exists in the shell —
	// static import would pull it into the desktop web bundle (and it is not
	// part of the desktop-web dependency tree's runtime surface).
	const { App } = await import("@capacitor/app");
	void App.addListener("backButton", ({ canGoBack }) => {
		// Layer-stack dispatch: every modal (agent drawer, sessions sheet,
		// server switcher, rail, panel, QR scanner) registered its own close
		// handler; the topmost consumes the press first. Only when no layer
		// claims it do we fall through to history / exit.
		if (dispatchBack()) return;
		if (canGoBack) {
			window.history.back();
		} else {
			void App.exitApp();
		}
	});
}
/**
 * DOM event carrying a native deep link (musepi://connect?link=<collab link>)
 * delivered by the OS — opened from a notification, a QR scanner, or a
 * `musepi://` URL. The app listener connects to the collab link directly,
 * bypassing the connect screen.
 */
export const DEEP_LINK_EVENT = "musepi:deep-link";

/**
 * Deep link that arrived before the app's event listener mounted (cold start:
 * the boot splash delays React mount past Capacitor's appUrlOpen replay).
 * `consumePendingDeepLink()` drains it once on mount; later links flow
 * through DEEP_LINK_EVENT.
 */
let pendingDeepLink: string | null = null;

/** Drain the pre-mount deep link (returns it at most once). */
export function consumePendingDeepLink(): string | null {
	const link = pendingDeepLink;
	pendingDeepLink = null;
	return link;
}

/**
 * Wire the native deep-link channel.
 *
 * Android: the `musepi://` intent filter (see AndroidManifest.xml) delivers
 * `appUrlOpen` on cold start (via the intent stash) and warm start.
 * HarmonyOS: the UIAbility's onNewWant/onCreate store the URI; the JS side
 * drains via harmonyNative.consumeDeepLink() or receives push via
 * window.__harmonyDeepLink callback.
 *
 * The URL shape is `musepi://connect?link=<url-encoded collab ws link>`.
 * Desktop web never calls this — browsers use the hash deep link instead.
 */
export async function setupDeepLinkHandler(): Promise<void> {
	if (isNativeShell()) {
		const { App } = await import("@capacitor/app");
		const handle = (url: string): void => {
			try {
				const parsed = new URL(url);
				const link = parsed.searchParams.get("link");
				if (parsed.protocol !== "musepi:" || !link) return;
				pendingDeepLink = link;
				window.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: { link } }));
			} catch {
				// malformed deep link — ignore
			}
		};
		void App.addListener("appUrlOpen", (data: { url: string }) => handle(data.url));
		void App.getLaunchUrl().then(launch => {
			if (launch?.url) handle(launch.url);
		});
	}

	if (isHarmonyShell()) {
		// Cold start: drain the pending want URI stored by EntryAbility.
		try {
			const raw = window.harmonyNative!.consumeDeepLink();
			if (raw) {
				const parsed = new URL(raw);
				const link = parsed.searchParams.get("link");
				if (parsed.protocol === "musepi:" && link) {
					pendingDeepLink = link;
					window.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: { link } }));
				}
			}
		} catch {
			// bridge not ready — rely on WebView warm-start push
		}
		// Warm-start deep links are pushed from ArkTS via
		// controller.runJavaScript('window.__harmonyDeepLink("...")').
		// Register the handler once.
		(window as unknown as Record<string, unknown>).__harmonyDeepLink = (raw: string): void => {
			try {
				const parsed = new URL(raw);
				const link = parsed.searchParams.get("link");
				if (parsed.protocol === "musepi:" && link) {
					window.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: { link } }));
				}
			} catch {
				// malformed
			}
		};
		// Also register the keyboard callback from ArkTS.
		(window as unknown as Record<string, unknown>).__harmonyKeyboard = (height: number): void => {
			const root = document.documentElement;
			root.style.setProperty("--mp-keyboard-inset", `${height}px`);
			const el = document.activeElement;
			if (el instanceof HTMLElement && el.closest(".sh-connect")) {
				el.scrollIntoView({ block: "center", behavior: "smooth" });
			}
		};
	}
}

/**
 * Notification-tap routing: LocalNotifications fires
 * `localNotificationActionPerformed` when the user taps a scheduled
 * notification (including cold start — the plugin replays the pending
 * action). The schedule payload carries `extra.link`; route it through the
 * same DEEP_LINK_EVENT the musepi:// handler uses.
 *
 * HarmonyOS: notification-tap routing is handled by EntryAbility's
 * onNewWant (the notification Intent carries the URI). Deep links from
 * notifications arrive through the same setupDeepLinkHandler path.
 */
export async function setupNotificationTapHandler(): Promise<void> {
	if (!isNativeShell()) return;
	const { LocalNotifications } = await import("@capacitor/local-notifications");
	void LocalNotifications.addListener("localNotificationActionPerformed", action => {
		const link = (action.notification.extra as { link?: string } | undefined)?.link;
		if (link) {
			window.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: { link } }));
		}
	});
}

/**
 * Fetch system-bar insets from the active shell. Returns dp/vp values
 * matching CSS px. Returns undefined when neither shell is available.
 */
export async function getSystemBarInsets(): Promise<{ top: number; bottom: number } | undefined> {
	if (isHarmonyShell()) {
		try {
			const raw = window.harmonyNative!.getSystemBars();
			const parsed = JSON.parse(raw) as { top: number; bottom: number };
			if (parsed != null && parsed.top > 0) return parsed;
		} catch {
			// plugin absent — fall through to Capacitor
		}
	}
	if (isNativeShell()) {
		try {
			return (await window.Capacitor?.nativePromise?.("Insets", "getSystemBars")) as
				| { top: number; bottom: number }
				| undefined;
		} catch {
			// plugin absent — fall through
		}
	}
	return undefined;
}

/**
 * Launcher icon badge (unread count) — Capacitor ShortcutBadger or
 * Harmony BadgeManager. Silently no-ops on unsupported launchers.
 */
export async function incrementBadge(): Promise<void> {
	if (!isMobileShell()) return;
	try {
		if (isHarmonyShell()) {
			const raw = window.harmonyNative!.getBadge();
			const { count } = JSON.parse(raw) as { count: number };
			window.harmonyNative!.setBadgeCount(count + 1);
			return;
		}
		if (isNativeShell()) {
			const Badge = window.Capacitor!.Plugins!.Badge as {
				get: () => Promise<{ count: number }>;
				set: (o: { count: number }) => Promise<void>;
				clear: () => Promise<void>;
			};
			const { count } = await Badge.get();
			await Badge.set({ count: count + 1 });
		}
	} catch {
		// launcher without badge support — silent
	}
}

/** Clear the launcher badge (foreground return / all read). */
export async function clearBadge(): Promise<void> {
	if (!isMobileShell()) return;
	try {
		if (isHarmonyShell()) {
			window.harmonyNative!.clearBadge();
			return;
		}
		if (isNativeShell()) {
			const Badge = window.Capacitor!.Plugins!.Badge as {
				clear: () => Promise<void>;
			};
			await Badge.clear();
		}
	} catch {
		// launcher without badge support — silent
	}
}
