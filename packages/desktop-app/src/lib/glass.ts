// Glass pipeline (settings → 外观).
//
// One fixed alpha per scheme, written to --gui-glass-alpha; CSS derives
// the scrim strength and the adaptive text colours from it. There is no
// preset selector any more: it used to trade see-through against blur,
// and with the window no longer borrowing an OS material there is no true
// see-through left to trade — the selector only offered a choice of how
// legible the glass happened to be. Legibility is not a preference, so
// it is derived instead: .gui-glass-adaptive is always on.
//
// Previously persisted ids (musepi-gui-glass, -v3) are ignored rather
// than migrated; there is nothing left to migrate them to.

/** Transparency per scheme (0–1, higher = more see-through). The light
 *  scheme sits lower so a bright translucent glass does not wash out. */
const GLASS_ALPHA = { dark: 0.55, light: 0.38 } as const;

/** Resolve the native window material for the current UI theme: the light
 *  scheme needs the bright vibrancy material — under-window dims the
 *  backdrop, which turns a light translucent glass grey. */
export function glassMaterialStyle(): "light" | "dark" {
	const theme = document.documentElement.dataset.theme;
	return theme === "light" ? "light" : "dark";
}

/** Write the fixed alpha and turn the adaptive-contrast class on. The
 *  window-transparency toggle strips the class when the user turns panes
 *  opaque, which is the one path that legitimately drops it. */
export function applyGlass(): void {
	const alpha = glassMaterialStyle() === "light" ? GLASS_ALPHA.light : GLASS_ALPHA.dark;
	const root = document.documentElement;
	root.style.setProperty("--gui-glass-alpha", String(alpha));
	root.classList.add("gui-glass-adaptive");
}

export type GlassMaterialStyle = "light" | "dark";

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
