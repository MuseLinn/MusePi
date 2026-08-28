import { isCompatShell } from "./compat-shell";

/**
 * Native window-glass contract for the Electron compat shell (the served
 * renderer). The frosted-glass pipeline (transparent html/body + translucent
 * scrims over the OS window material) previously existed only in the gui
 * bundle — the compat shell wrapped the SAME acrylic/vibrancy window around
 * a fully opaque page, so the sidebar, top bar and the area around the main
 * card never read as glass (user: 该透明的区域仍没有透明).
 *
 * Gated on the compat shell marker (`?shell=1`) AND the Electron bridge: a
 * plain-browser guest has no window material, so it keeps the opaque paint.
 */
const BRIDGE = window as unknown as {
	electronAPI?: { setWindowGlass?(on: boolean, style?: "light" | "dark"): void };
};

export function nativeGlassAvailable(): boolean {
	return isCompatShell() && typeof BRIDGE.electronAPI?.setWindowGlass === "function";
}

/** Mirror the current theme onto the window material (light scheme needs the
 * bright material — under-window dims it grey, gui glass.ts parity). */
function applyNativeGlass(): void {
	const dark = document.documentElement.dataset.theme !== "light";
	BRIDGE.electronAPI?.setWindowGlass?.(true, dark ? "dark" : "light");
}

let wired = false;

/** Opt the served renderer into the native glass: transparent root, the
 * shell scrims go translucent (shell.css `.sh-native-glass` rules), and the
 * theme is mirrored onto the window material. Idempotent. */
export function enableNativeGlass(): void {
	if (wired || !nativeGlassAvailable()) return;
	wired = true;
	document.documentElement.classList.add("sh-native-glass");
	applyNativeGlass();
	// Theme flips must re-match the material to the scheme.
	new MutationObserver(applyNativeGlass).observe(document.documentElement, {
		attributeFilter: ["data-theme"],
		attributes: true,
	});
}
