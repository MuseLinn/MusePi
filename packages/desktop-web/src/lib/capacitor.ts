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
			/** Low-level bridge: call a native-registered plugin by name. */
			nativePromise?: <T = unknown>(pluginName: string, methodName: string, options?: Record<string, unknown>) => Promise<T>;
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
 * `appUrlOpen` on cold start (via the intent stash) and warm start. iOS would
 * need the same scheme in Info.plist + the app delegate — out of scope here,
 * the shell is Android-first (mobile.html only runs on Android today).
 *
 * The URL shape is `musepi://connect?link=<url-encoded collab ws link>`.
 * Desktop web never calls this — browsers use the hash deep link instead.
 */
export async function setupDeepLinkHandler(): Promise<void> {
	if (!isNativeShell()) return;
	const { App } = await import("@capacitor/app");
	const handle = (url: string): void => {
		try {
			const parsed = new URL(url);
			const link = parsed.searchParams.get("link");
			if (parsed.protocol !== "musepi:" || !link) return;
			// Stash first: on cold start this fires before the app's listener
			// mounts (boot splash), so the event alone would be lost.
			pendingDeepLink = link;
			window.dispatchEvent(new CustomEvent(DEEP_LINK_EVENT, { detail: { link } }));
		} catch {
			// malformed deep link — ignore
		}
	};
	void App.addListener("appUrlOpen", (data: { url: string }) => handle(data.url));
	// Cold start: the launch intent carries the URL; appUrlOpen may or may not
	// replay it depending on activity launch mode timing — getLaunchUrl is
	// authoritative for the cold-start case.
	void App.getLaunchUrl().then(launch => {
		if (launch?.url) handle(launch.url);
	});
}

/**
 * Notification-tap routing: LocalNotifications fires
 * `localNotificationActionPerformed` when the user taps a scheduled
 * notification (including cold start — the plugin replays the pending
 * action). The schedule payload carries `extra.link`; route it through the
 * same DEEP_LINK_EVENT the musepi:// handler uses.
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
 * Launcher icon badge (unread count) via ShortcutBadger — Samsung/Xiaomi/
 * Huawei/Oppo launchers; silently no-ops on launchers without badge support
 * (Pixel's native launcher). The count increments per background
 * notification and clears when the app returns to the foreground.
 */
export async function incrementBadge(): Promise<void> {
	if (!isNativeShell()) return;
	try {
		// Badge is registered by the bundle (registerPlugin).
		// Use Plugins directly to avoid runtime import resolution issues.
		const Badge = window.Capacitor!.Plugins!.Badge as {
			get: () => Promise<{ count: number }>;
			set: (o: { count: number }) => Promise<void>;
			clear: () => Promise<void>;
		};
		const { count } = await Badge.get();
		await Badge.set({ count: count + 1 });
	} catch {
		// launcher without badge support — silent
	}
}

/** Clear the launcher badge (foreground return / all read). */
export async function clearBadge(): Promise<void> {
	if (!isNativeShell()) return;
	try {
		const Badge = window.Capacitor!.Plugins!.Badge as {
			clear: () => Promise<void>;
		};
		await Badge.clear();
	} catch {
		// launcher without badge support — silent
	}
}
