import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/mobile.css";
import "./i18n";
import { isNativeShell, setupAndroidBackHandler } from "./lib/capacitor";

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

// Immersive fallback: some Android compatibility layers (卓易通) ship an older
// WebView that ignores env(safe-area-inset-*). Detect that and inject the
// CSS variables from native StatusBar info if the plugin reports them;
// otherwise fall back to a fixed status-bar allowance (~24dp, scaled by DPR
// is handled natively — we use CSS px so 24px is the conservative default).
async function setupSafeAreaFallback(): Promise<void> {
	const css = document.documentElement;
	const supportsEnv = typeof CSS !== "undefined" && CSS.supports("padding-top", "env(safe-area-inset-top, 0px)");
	if (!supportsEnv) {
		// Old WebView: fixed allowance. 24px top (status bar) + 12px bottom.
		css.style.setProperty("--safe-top", "24px");
		css.style.setProperty("--safe-bottom", "12px");
	}
	try {
		const mod = await import("@capacitor/status-bar");
		const { StatusBar } = mod;
		const info = await StatusBar.getInfo();
		// getInfo() exposes height() via the underlying plugin only on newer
		// versions; when present it beats the CSS guess.
		const withHeight = StatusBar as typeof StatusBar & { height?: () => Promise<{ height: number }> };
		if (typeof withHeight.height === "function") {
			const { height } = await withHeight.height();
			if (height > 0) css.style.setProperty("--safe-top", `${height}px`);
		}
		void info;
	} catch {
		// plugin absent (browser) — env()/fixed fallback stands
	}
}

void setupCapacitorKeyboardInset();
setupVisualViewportKeyboardFallback();
void setupSafeAreaFallback();
void setupImmersiveSystemBars();
void setupAndroidBackHandler();

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
