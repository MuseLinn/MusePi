import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { DotMatrixMark } from "./components/shell/DotMatrixMark";
import "./styles/tokens.css";
import "./styles/fonts.css";
import "./styles/base.css";
import "./styles/mobile.css";
import "./styles/overlay-fallback.css";
import "./i18n";
import {
	getSystemBarInsets,
	isNativeShell,
	setupAndroidBackHandler,
	setupDeepLinkHandler,
	setupNotificationTapHandler,
} from "./lib/capacitor";
import { applyTextScale } from "./lib/text-scale";
import { initTooltips } from "./lib/tooltips";

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

// Browser/PWA path: there is NO keyboard inset here, on purpose.
//
// The shell is sized from --viewport-height, which app.tsx keeps equal to
// visualViewport.height on every surface. When an IME opens in a browser the
// visual viewport shrinks, the shell shrinks with it, and the composer is
// already clear of the keyboard. The previous fallback ALSO wrote
// --mp-keyboard-inset from `innerHeight - vv.height`, so the composer was
// lifted a second time by a full keyboard height and floated in the middle of
// the screen. Worse, pinch-zoom shrinks the visual viewport without any
// keyboard, which that delta read as one.
//
// The native shells are the opposite contract — Keyboard resize:'none' keeps
// the WebView at full height, so there the inset (from the plugin events above
// or ArkTS) is the only keyboard avoidance and the shell height does not
// change. One mechanism per surface, never both.

// Edge-to-edge: paint under the system bars and pick icon color for the
// active theme. Capacitor's config handles this on fresh installs, but an
// explicit boot call is what actually applies it on every Android version /
// ROM (and fixes the pre-first-paint flash on stale themes).
async function setupImmersiveSystemBars(): Promise<void> {
	try {
		const { StatusBar, Style } = await import("@capacitor/status-bar");
		await StatusBar.setOverlaysWebView({ overlay: true });
		await StatusBar.setBackgroundColor({ color: "#00000000" });
		const syncStyle = async (): Promise<void> => {
			// Style.Dark = light text (dark backgrounds), Style.Light = dark text.
			const dark = document.documentElement.dataset.theme === "dark";
			await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
		};
		await syncStyle();
		// ThemeToggle updates the root dataset after boot. Keep the native icons
		// readable when the scheme changes without re-entering the application.
		new MutationObserver(() => void syncStyle().catch(() => {})).observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
	} catch {
		// Browser / desktop web — no native bars to paint under.
	}
}

// Android WebView (and HarmonyOS WebView) never surface real system-bar
// insets via env(safe-area-inset-*) — the value is always 0. The shared
// getSystemBarInsets() function probes the active shell (Capacitor or
// harmonyNative) and returns the true bar heights; a fixed allowance covers
// shells where the native plugin may not be reachable.
async function setupSafeAreaFallback(): Promise<void> {
	const css = document.documentElement;
	// Conservative defaults: 48px top (covers cutout/punch-hole status bars),
	// 24px bottom (gesture nav). Real values from the plugin override these.
	css.style.setProperty("--safe-top", "48px");
	css.style.setProperty("--safe-bottom", "24px");
	try {
		const insets = await getSystemBarInsets();
		if (insets && insets.top > 0) css.style.setProperty("--safe-top", `${insets.top}px`);
		if (insets && insets.bottom > 0) css.style.setProperty("--safe-bottom", `${insets.bottom}px`);
	} catch {
		// plugin absent — fixed allowance stands
	}
}

void setupCapacitorKeyboardInset();
void setupSafeAreaFallback();
void setupImmersiveSystemBars();
void setupAndroidBackHandler();
void setupDeepLinkHandler();
void setupNotificationTapHandler();
// Physical-density text correction (text only — geometry keeps its scale).
void applyTextScale();

/** Launch splash — an overlay above the live app, so connection and initial
 * state loading start immediately instead of waiting for the brand animation.
 *
 * Reduced motion skips it entirely (the design-system contract: the cold-start
 * reveal is decorative — "system reduced-motion skips it"), and it never holds
 * the shell for its full duration once the app is interactive: a tap or the
 * exit timer both release it, and the exit timer is short because the brand
 * beat is 1.4 s of someone's life on every cold start. */
function BootSplash({ onDone }: { onDone: () => void }): React.JSX.Element | null {
	const [leaving, setLeaving] = useState(false);
	// Read once per mount: a mid-launch preference change is not worth a
	// re-render, and the reveal has already started by then.
	const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	useEffect(() => {
		if (reduced) {
			onDone();
			return;
		}
		let exitTimer: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			setLeaving(true);
			exitTimer = setTimeout(onDone, 260);
		}, 1400);
		return () => {
			clearTimeout(timer);
			if (exitTimer) clearTimeout(exitTimer);
		};
	}, [onDone, reduced]);
	if (reduced) return null;
	return (
		<div className={`sh-boot-splash${leaving ? " sh-boot-splash--leave" : ""}`} onClick={onDone} role="presentation">
			<div className="sh-boot-splash-dots">
				<DotMatrixMark text="MusePi" fontSize={48} gridGap={6} dotRadius={1.6} />
			</div>
		</div>
	);
}

function Root(): React.JSX.Element {
	const [splash, setSplash] = useState(true);
	return (
		<>
			<App />
			{splash && <BootSplash onDone={() => setSplash(false)} />}
		</>
	);
}

initTooltips();
const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<Root />);
