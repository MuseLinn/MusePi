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
	isHarmonyShell,
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

// Edge-to-edge: paint under the system bars and keep their icons readable.
//
// Android: the StatusBar plugin owns the bars. HarmonyOS: the ArkTS window
// owns them, so the page only pushes its resolved scheme through
// harmonyNative.setThemeColor(dark) — EntryAbility makes the bars transparent
// and picks the content colour from it. Both paths re-sync on every scheme
// flip, including follow-system changes delivered over the native bridge.
function setupImmersiveSystemBars(): void {
	const root = document.documentElement;
	const syncNative = (): void => {
		const dark = root.dataset.theme !== "light";
		if (isHarmonyShell()) {
			try {
				window.harmonyNative?.setThemeColor?.(dark);
			} catch {
				// bridge not injected yet — the delayed pass below retries
			}
		} else if (isNativeShell()) {
			void (async () => {
				try {
					const { StatusBar, Style } = await import("@capacitor/status-bar");
					await StatusBar.setOverlaysWebView({ overlay: true });
					await StatusBar.setBackgroundColor({ color: "#00000000" });
					// Style.Dark = light text (dark backgrounds), Style.Light = dark text.
					await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
				} catch {
					// Browser / desktop web — no native bars to paint under.
				}
			})();
		}
	};
	syncNative();
	// javaScriptProxy may land a tick after the module graph executes.
	window.setTimeout(syncNative, 60);
	new MutationObserver(syncNative).observe(root, {
		attributes: true,
		attributeFilter: ["data-theme", "data-color-scheme"],
	});
}

/**
 * Safe-area insets.
 *
 * ArkWeb implements the W3C `env(safe-area-inset-*)` variables when the shell
 * enables immersive layout with `viewport-fit=cover`; the engine continuously
 * recomputes them from the overlap between the Web component and the system
 * avoid areas, so they already account for fold state, rotation, cutouts and
 * free windows. Prefer them. Only when the engine reports 0 do we fall back to
 * the native bridge's `getSystemBars()` (Capacitor WebViews do not expose
 * env()). Never hard-code status-bar/gesture-bar heights: Pura X View and the
 * Pura X Max inner screen have larger top avoid areas than a phone.
 */
type EnvInsets = { top: number; bottom: number; left: number; right: number };

function readEnvInsets(): EnvInsets {
	if (typeof document === "undefined" || !document.body) {
		return { top: 0, bottom: 0, left: 0, right: 0 };
	}
	const probe = document.createElement("div");
	probe.style.cssText =
		"position:absolute;visibility:hidden;pointer-events:none;" +
		"padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);" +
		"padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);";
	document.body.appendChild(probe);
	const cs = getComputedStyle(probe);
	const num = (value: string): number => Number.parseFloat(value) || 0;
	const result = {
		top: num(cs.paddingTop),
		bottom: num(cs.paddingBottom),
		left: num(cs.paddingLeft),
		right: num(cs.paddingRight),
	};
	probe.remove();
	return result;
}

async function setupSafeAreaFallback(): Promise<void> {
	const css = document.documentElement;
	const apply = (native?: { top: number; bottom: number }): void => {
		const env = readEnvInsets();
		css.style.setProperty("--safe-top", `${env.top || native?.top || 0}px`);
		css.style.setProperty("--safe-bottom", `${env.bottom || native?.bottom || 0}px`);
		css.style.setProperty("--safe-left", `${env.left}px`);
		css.style.setProperty("--safe-right", `${env.right}px`);
	};
	apply();
	try {
		const insets = await getSystemBarInsets();
		apply(insets);
	} catch {
		// plugin absent — env() or zero stands
	}
	// Fold / rotate / free-window changes move the avoid areas; the HarmonyOS
	// bridge answers synchronously from AppStorage, so re-reading is cheap.
	const resync = (): void => {
		apply();
		void getSystemBarInsets()
			.then(apply)
			.catch(() => {});
	};
	window.addEventListener("resize", resync);
	window.addEventListener("orientationchange", resync);
}

void setupCapacitorKeyboardInset();
void setupSafeAreaFallback();
setupImmersiveSystemBars();
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
