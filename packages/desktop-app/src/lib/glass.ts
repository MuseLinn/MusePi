// Glass transparency pipeline (settings → 外观):
//
// The transparency control is a PRESET selector (light / standard / strong)
// rather than a continuous slider — matching the platform norm (macOS
// "reduce transparency" / Windows "transparency effects" are both toggles,
// never a slider). Each preset maps to an alpha (0–1, higher = more
// see-through) that is theme-aware: the light scheme needs a lower alpha
// so a bright translucent glass doesn't wash out.
//
// The renderer writes the preset id to --gui-glass-alpha via applyGlassPreset,
// and CSS derives the scrim strength and adaptive text colors from it.
//
// v1 of the pref stored a numeric scrim-strength coefficient and v2 stored
// the transparency percentage (30–90). readGlassPreset() migrates a stored
// value once to a preset id under a version marker.

const GLASS_KEY = "musepi-gui-glass";
const GLASS_V3_KEY = "musepi-gui-glass-v3";

/** Literal preset ids — keeping this narrow lets the UI's template i18n key
 *  (`glass preset ${p.id}`) resolve to a valid TranslationKey union member. */
export type GlassPresetId = "light" | "standard" | "strong";

export interface GlassPreset {
	/** stored id (persisted in localStorage) */
	id: GlassPresetId;
	/** i18n key: `glass preset ${id}` */
	labelKey: string;
	/** dark-scheme alpha (0–1, higher = more see-through) */
	darkAlpha: number;
	/** light-scheme alpha (0–1) — lower than dark so light glass stays readable */
	lightAlpha: number;
}

/** Preset ladder, ordered light → strong. Same order shown in the UI. */
export const GLASS_PRESETS: GlassPreset[] = [
	{ id: "light", labelKey: "glass preset light", darkAlpha: 0.35, lightAlpha: 0.22 },
	{ id: "standard", labelKey: "glass preset standard", darkAlpha: 0.55, lightAlpha: 0.38 },
	{ id: "strong", labelKey: "glass preset strong", darkAlpha: 0.75, lightAlpha: 0.55 },
];

/** Resolve the native window material for the current UI theme: the light
 *  scheme needs the bright vibrancy material — under-window dims the
 *  backdrop, which turns a light translucent glass grey. */
export function glassMaterialStyle(): "light" | "dark" {
	const theme = document.documentElement.dataset.theme;
	return theme === "light" ? "light" : "dark";
}

function presetById(id: string | null | undefined): GlassPreset {
	return GLASS_PRESETS.find(p => p.id === id) ?? GLASS_PRESETS[1]!;
}

/** Map a legacy numeric transparency (30–90, v2) or scrim coefficient (v1)
 *  onto the nearest preset id. */
function numericToPreset(v: number): GlassPreset {
	const alpha = v / 100;
	let best = GLASS_PRESETS[0]!;
	let bestDist = Number.POSITIVE_INFINITY;
	for (const p of GLASS_PRESETS) {
		// preset "alpha" for matching purposes: average of dark/light — the
		// stored value is theme-independent, so no single exact target.
		const target = (p.darkAlpha + p.lightAlpha) / 2;
		const d = Math.abs(target - alpha);
		if (d < bestDist) {
			bestDist = d;
			best = p;
		}
	}
	return best;
}

/** Read the persisted preset id, migrating legacy numeric values once. */
export function readGlassPreset(): GlassPreset {
	const stored = localStorage.getItem(GLASS_KEY);
	if (!localStorage.getItem(GLASS_V3_KEY)) {
		// legacy: numeric scrim coefficient (v1) or transparency % (v2)
		const n = Number(stored);
		if (Number.isFinite(n) && n >= 0 && n <= 100) {
			const preset = numericToPreset(n);
			localStorage.setItem(GLASS_KEY, preset.id);
			localStorage.setItem(GLASS_V3_KEY, "1");
			return preset;
		}
		localStorage.setItem(GLASS_V3_KEY, "1");
	}
	return presetById(stored);
}

/** Resolve the preset alpha for the current theme. */
export function presetAlpha(preset: GlassPreset, theme: "light" | "dark" = glassMaterialStyle()): number {
	return theme === "light" ? preset.lightAlpha : preset.darkAlpha;
}

/** Apply a preset to the document root (theme-aware alpha). */
export function applyGlassPreset(preset: GlassPreset): void {
	const t = presetAlpha(preset);
	const root = document.documentElement;
	root.style.setProperty("--gui-glass-alpha", String(t));
	// ≥50% transparent: blend glass-pane text toward white (dark scheme) or
	// keep it dark (light scheme) — CSS derives the colors from the alpha.
	root.classList.toggle("gui-glass-adaptive", t >= 0.5);
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
