// Glass transparency pipeline (settings → 外观):
//
// The slider value IS the transparency percentage (30–90): higher = more
// see-through. The renderer writes it as --gui-glass-alpha (0.3–0.9) and
// derives the scrim strength and the adaptive text colors in CSS, so the
// slider reads in the same direction as the "磨砂玻璃透明度" label.
//
// v1 of the pref stored the scrim-strength coefficient (higher = MORE
// opaque) — the direction the label now contradicts. readGlassLevel()
// migrates the stored value once (40 v1 ≈ 60 v2) under a version marker.

const GLASS_KEY = "musepi-gui-glass";
const GLASS_V2_KEY = "musepi-gui-glass-v2";

export const GLASS_MIN = 30;
export const GLASS_MAX = 90;

/** Migrated transparency percentage from localStorage (default 55). */
export function readGlassLevel(): number {
	let v = Number(localStorage.getItem(GLASS_KEY) ?? 55);
	if (!Number.isFinite(v) || v < 0 || v > 100) v = 55;
	if (!localStorage.getItem(GLASS_V2_KEY)) {
		v = Math.min(GLASS_MAX, Math.max(GLASS_MIN, 100 - v));
		localStorage.setItem(GLASS_KEY, String(v));
		localStorage.setItem(GLASS_V2_KEY, "1");
	}
	return v;
}

/** Apply a transparency level (30–90) to the document root. */
export function applyGlassLevel(v: number): void {
	const t = Math.min(GLASS_MAX, Math.max(GLASS_MIN, v)) / 100;
	const root = document.documentElement;
	root.style.setProperty("--gui-glass-alpha", String(t));
	// ≥50% transparent: blend glass-pane text toward white (dark scheme) or
	// keep it dark (light scheme) — CSS derives the colors from the alpha.
	root.classList.toggle("gui-glass-adaptive", t >= 0.5);
}

export type GlassMaterialStyle = "light" | "dark";

/** Resolve the native window material for the current UI theme: the light
 *  scheme needs the bright vibrancy material — under-window dims the
 *  backdrop, which turns a light translucent glass grey. */
export function glassMaterialStyle(): GlassMaterialStyle {
	const theme = document.documentElement.dataset.theme;
	return theme === "light" ? "light" : "dark";
}

/**
 * Mirror the glass state onto the native window material (electron shell).
 * Call whenever the transparency toggle, the theme, or the window's
 * electronAPI availability changes; the main process maps the style onto
 * the matching vibrancy material / opaque base color.
 */
export function applyGlassMaterial(enabled: boolean): void {
	const glassApi = (
		window as unknown as { electronAPI?: { setWindowGlass?: (on: boolean, style?: GlassMaterialStyle) => void } }
	).electronAPI;
	void glassApi?.setWindowGlass?.(enabled, glassMaterialStyle());
}
