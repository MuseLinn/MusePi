import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/mobile.css";
import "./i18n";
import {
	isNativeShell,
	setupAndroidBackHandler,
	setupDeepLinkHandler,
	setupNotificationTapHandler,
} from "./lib/capacitor";

// Capacitor keyboard bridge: with Keyboard resize 'none' the WebView keeps its
// full height when the soft keyboard opens, so the visual viewport never
// shrinks. Drive the --mp-keyboard-inset CSS variable from the plugin events
// instead; the composer and header consume it. This entry only runs inside the
// Capacitor shell (mobile.html); the desktop web entry never touches it.
// Native plugins are reached through their JS modules (platform-specific,
// dynamic imports); shell detection lives in lib/capacitor.ts.

async function setupCapacitorKeyboardInset(): Promise<void> {
	if (!isNativeShell()) return;
	// Platform-specific module: the Keyboard plugin module registers itself
	// on window.Capacitor.Plugins when imported; `window.Capacitor.plugins`
	// (lowercase) is never populated on real Android WebViews.
	const { Keyboard } = await import("@capacitor/keyboard");
	const root = document.documentElement;
	await Keyboard.removeAllListeners();
	Keyboard.addListener("keyboardWillShow", (info: { keyboardHeight: number }) => {
		root.style.setProperty("--mp-keyboard-inset", `${info.keyboardHeight}px`);
		// Lift the focused input above the IME inside the connect guide
		// (the guide is a scroll container — scrollIntoView scrolls it).
		const el = document.activeElement;
		if (el instanceof HTMLElement && el.closest(".sh-connect")) {
			el.scrollIntoView({ block: "center", behavior: "smooth" });
		}
	});
	Keyboard.addListener("keyboardWillHide", () => {
		root.style.setProperty("--mp-keyboard-inset", "0px");
	});
}

// VisualViewport fallback: shells without the Keyboard plugin (older compat
// WebViews, plain browsers) still shrink the visual viewport when the IME
// shows. Drive the same CSS variable from the vv delta; the plugin events
// above take precedence when present.
function setupVisualViewportKeyboardFallback(): void {
	if (window.Capacitor?.plugins?.Keyboard) return;
	const vv = window.visualViewport;
	if (!vv) return;
	const root = document.documentElement;
	const update = (): void => {
		const kb = Math.max(0, window.innerHeight - vv.height);
		root.style.setProperty("--mp-keyboard-inset", kb > 60 ? `${kb}px` : "0px");
	};
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	update();
}

// Edge-to-edge: paint under the system bars and pick icon color for the
// active theme. Capacitor's config handles this on fresh installs, but an
// explicit boot call is what actually applies it on every Android version /
// ROM (and fixes the pre-first-paint flash on stale themes).
async function setupImmersiveSystemBars(): Promise<void> {
	try {
		const { StatusBar, Style } = await import("@capacitor/status-bar");
		await StatusBar.setOverlaysWebView({ overlay: true });
		// Style.Dark = light text (dark backgrounds), Style.Light = dark text.
		const dark = document.documentElement.dataset.theme === "dark";
		await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
		await StatusBar.setBackgroundColor({ color: "#00000000" });
	} catch {
		// Browser / desktop web — no native bars to paint under.
	}
}

// Android WebView never surfaces real system-bar insets via
// env(safe-area-inset-*) — CSS.supports("env(...)") returns true but the
// value is always 0, even in edge-to-edge mode. The native Insets plugin
// (see MainActivity/InsetsPlugin) reads the true status/nav bar heights and
// we inject them as the CSS variables; a fixed allowance covers older
// compatibility layers (卓易通) where the plugin may not be reachable.
async function setupSafeAreaFallback(): Promise<void> {
	const css = document.documentElement;
	// Conservative defaults: 48px top (covers cutout/punch-hole status bars),
	// 24px bottom (gesture nav). Real values from the plugin override these.
	css.style.setProperty("--safe-top", "48px");
	css.style.setProperty("--safe-bottom", "24px");
	try {
		// Insets is a native-only plugin (no JS module), so it is not present
		// in window.Capacitor.Plugins — call it through the low-level bridge.
		const insets = (await window.Capacitor?.nativePromise?.("Insets", "getSystemBars")) as
			| { top: number; bottom: number }
			| undefined;
		if (insets && insets.top > 0) css.style.setProperty("--safe-top", `${insets.top}px`);
		if (insets && insets.bottom > 0) css.style.setProperty("--safe-bottom", `${insets.bottom}px`);
	} catch {
		// plugin absent (browser / old compat layer) — fixed allowance stands
	}
}

void setupCapacitorKeyboardInset();
setupVisualViewportKeyboardFallback();
void setupSafeAreaFallback();
void setupImmersiveSystemBars();
void setupAndroidBackHandler();
void setupDeepLinkHandler();
void setupNotificationTapHandler();

/** Launch splash — brief brand animation before the connect guide. The
 *  spring curve mirrors the shell tokens; clicking skips straight in. */
function BootSplash({ onDone }: { onDone: () => void }): React.JSX.Element {
	const [leaving, setLeaving] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => {
			setLeaving(true);
			setTimeout(onDone, 260);
		}, 900);
		return () => clearTimeout(timer);
	}, [onDone]);
	return (
		<div className={`sh-boot-splash${leaving ? " sh-boot-splash--leave" : ""}`} onClick={onDone} role="presentation">
			<div className="sh-boot-splash-mark">
				<span className="sh-boot-splash-pi">π</span>
			</div>
			<div className="sh-boot-splash-word">MusePi</div>
		</div>
	);
}

function Root(): React.JSX.Element {
	const [splash, setSplash] = useState(true);
	if (splash) return <BootSplash onDone={() => setSplash(false)} />;
	return <App />;
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Root />);
