/**
 * Scrollbar skin registry (FloatingScrollbar styling, petdex-style pluggable).
 *
 * Two built-in bases:
 *  - `gummy`  — a jelly capsule thumb (height = visible ratio) that
 *    stretches while scrolling and springs back; accent-tinted glass.
 *  - `pacman` — the bead-string rail: a hairline thread, a string of
 *    beads at 7px pitch, and a pac-man riding the thread eating its way
 *    down (beads above it are "eaten" = dimmed).
 *
 * Imported skins are petdex-shaped: a zip holding `scrollbar.json`
 * (id/displayName/base/colors/size + optional pacGlyphPath SVG) unpacked
 * by the main process, validated here, persisted to localStorage, and
 * listed in the settings picker next to the built-ins. The online market
 * IPC slots (`scrollbar-skin-search` / `scrollbar-skin-install-url`)
 * exist but are unimplemented skeletons.
 */

export interface ScrollbarSkinColors {
	/** Primary tint — beads (pacman) or capsule glass (gummy). */
	accent: string;
	/** Thread / track color. */
	track: string;
	/** "Eaten" beads (pacman) / scrolled region tint (gummy). */
	eaten: string;
}

export interface ScrollbarSkin {
	id: string;
	displayName: string;
	base: "gummy" | "pacman";
	colors: ScrollbarSkinColors;
	/** Rail/capsule width in px. */
	size: number;
	/** Optional data URL of a custom SVG glyph replacing the built-in
	 *  pac-man (pacman base only). */
	pacGlyph: string | null;
	/** Set for imported skins. */
	importedAt?: number;
}

export const SCROLLBAR_STYLE_KEY = "omp-gui-scrollbar-style";
export const SCROLLBAR_SKINS_KEY = "omp-gui-scrollbar-skins";
/** Fired on the window when the imported-skin registry changes. */
export const SCROLLBAR_SKINS_CHANGED_EVENT = "omp-scrollbar-skins-changed";
/** Fired on the window when the active skin id changes. */
export const SCROLLBAR_STYLE_CHANGED_EVENT = "omp-scrollbar-style-changed";

const BUILTIN_PACMAN: ScrollbarSkin = {
	id: "builtin-pacman",
	displayName: "Pac-man",
	base: "pacman",
	colors: {
		accent: "#ffd94d",
		track: "color-mix(in oklab, var(--color-text-faint, var(--color-text, oklch(0.6 0.02 60))) 30%, transparent)",
		eaten: "#7a7462",
	},
	size: 12,
	pacGlyph: null,
};

const BUILTIN_GUMMY: ScrollbarSkin = {
	id: "builtin-gummy",
	displayName: "Gummy",
	base: "gummy",
	colors: {
		accent: "var(--color-accent)",
		track: "color-mix(in oklab, var(--color-text-faint, var(--color-text, oklch(0.6 0.02 60))) 30%, transparent)",
		eaten: "transparent",
	},
	size: 12,
	pacGlyph: null,
};

export const BUILTIN_SCROLLBAR_SKINS: ScrollbarSkin[] = [BUILTIN_GUMMY, BUILTIN_PACMAN];
/** Imported skins first in the picker, built-ins after. */
export const DEFAULT_SCROLLBAR_SKIN_ID = BUILTIN_GUMMY.id;

/** Pure shape validation for a main-process unpacked skin zip. */
export function validateImportedSkin(raw: unknown): ScrollbarSkin | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id) return null;
	if (typeof r.displayName !== "string" || !r.displayName) return null;
	if (r.base !== "gummy" && r.base !== "pacman") return null;
	const colors = (typeof r.colors === "object" && r.colors !== null ? r.colors : {}) as Record<string, unknown>;
	const accent = typeof colors.accent === "string" && colors.accent ? colors.accent : BUILTIN_PACMAN.colors.accent;
	const track = typeof colors.track === "string" && colors.track ? colors.track : BUILTIN_GUMMY.colors.track;
	const eaten = typeof colors.eaten === "string" && colors.eaten ? colors.eaten : BUILTIN_PACMAN.colors.eaten;
	const size = typeof r.size === "number" && Number.isFinite(r.size) ? Math.min(24, Math.max(6, Math.round(r.size))) : 12;
	const pacGlyph = typeof r.pacGlyph === "string" && r.pacGlyph.startsWith("data:") ? r.pacGlyph : null;
	return {
		id: r.id,
		displayName: r.displayName,
		base: r.base,
		colors: { accent, track, eaten },
		size,
		pacGlyph,
		importedAt: typeof r.importedAt === "number" ? r.importedAt : Date.now(),
	};
}

export function readImportedSkins(): ScrollbarSkin[] {
	try {
		const raw = localStorage.getItem(SCROLLBAR_SKINS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map(s => validateImportedSkin(s))
			.filter((s): s is ScrollbarSkin => s !== null);
	} catch {
		return [];
	}
}

export function getScrollbarSkins(): ScrollbarSkin[] {
	return [...readImportedSkins(), ...BUILTIN_SCROLLBAR_SKINS];
}

/** Resolve a skin by id, falling back to the built-in gummy. */
export function getScrollbarSkin(id: string | null): ScrollbarSkin {
	const skins = getScrollbarSkins();
	return skins.find(s => s.id === id) ?? BUILTIN_GUMMY;
}

/** Persist an imported skin (same id replaces the old one) + notify. */
export function saveImportedSkin(skin: ScrollbarSkin): void {
	const rest = readImportedSkins().filter(s => s.id !== skin.id);
	try {
		localStorage.setItem(SCROLLBAR_SKINS_KEY, JSON.stringify([skin, ...rest]));
	} catch {
		// storage unavailable — skin stays for this session only
	}
	window.dispatchEvent(new Event(SCROLLBAR_SKINS_CHANGED_EVENT));
}

export function readScrollbarStyle(): string {
	return localStorage.getItem(SCROLLBAR_STYLE_KEY) ?? DEFAULT_SCROLLBAR_SKIN_ID;
}
