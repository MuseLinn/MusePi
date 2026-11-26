/**
 * Scrollbar skin catalog — owned by the `ui-theme` Cordis bundle.
 *
 * The scrollbar is native (`packages/client-core/src/styles/base.css`): the
 * engine draws, sizes, drags and exposes it, so layout width, hover, keyboard
 * and the OS accessibility surface stay the platform's. A skin is therefore
 * only a palette plus, for a built-in, a thumb recipe:
 *
 *  - `classic`  — the neutral capsule, the default.
 *  - `builtin-snake` — a tinted capsule with a head, an eye and vertebra seams.
 *  - `builtin-gummy-rainbow` — the candy capsule with a fixed rainbow fill.
 *
 * Built-in recipes live in `skins.css`, keyed by `html[data-scrollbar-skin]`.
 * Imported and contributed skins only rebind the palette through
 * `--mp-scrollbar-skin-*`, so the elevation rebinding that recolors `classic`
 * recolors them too. `base` and `pacGlyph` remain in the import/extension wire
 * format for compatibility; the native renderer has no place for a glyph and
 * selects the recipe by skin id.
 */

export interface ScrollbarSkinColors {
	/** Primary tint — the capsule fill. */
	accent: string;
	/** Track colour (reserved; the native track stays transparent). */
	track: string;
	/** Scrolled-region tint (reserved). */
	eaten: string;
}

export interface ScrollbarSkin {
	id: string;
	displayName: string;
	/** Legacy geometry field kept for the extension/import wire format. */
	base: "gummy" | "pacman";
	colors: ScrollbarSkinColors;
	/** Bar width in px. A native scrollbar wider than 16px eats layout. */
	size: number;
	/** Legacy glyph field kept for the wire format; unused by the native bar. */
	pacGlyph: string | null;
	/** Set for imported skins. */
	importedAt?: number;
}

export const SCROLLBAR_STYLE_KEY = "musepi-gui-scrollbar-style";
export const SCROLLBAR_SKINS_KEY = "musepi-gui-scrollbar-skins";
/** Fired on the window when the imported-skin registry changes. */
export const SCROLLBAR_SKINS_CHANGED_EVENT = "musepi-scrollbar-skins-changed";
/** Fired on the window when the active skin id changes. */
export const SCROLLBAR_STYLE_CHANGED_EVENT = "musepi-scrollbar-style-changed";

/** Smallest and largest bar width a skin may request. Beyond 16px the bar
 *  takes a visible strip of content width on every scroller. */
const MIN_SKIN_WIDTH = 6;
const MAX_SKIN_WIDTH = 16;

const clampWidth = (value: number): number => Math.min(MAX_SKIN_WIDTH, Math.max(MIN_SKIN_WIDTH, Math.round(value)));

const BUILTIN_CLASSIC: ScrollbarSkin = {
	id: "classic",
	displayName: "Classic",
	base: "gummy",
	colors: {
		accent: "var(--color-text-faint)",
		track: "transparent",
		eaten: "transparent",
	},
	size: 5,
	pacGlyph: null,
};

const BUILTIN_SNAKE: ScrollbarSkin = {
	id: "builtin-snake",
	displayName: "Snake",
	base: "gummy",
	colors: {
		accent: "var(--color-accent)",
		track: "transparent",
		eaten: "transparent",
	},
	size: 12,
	pacGlyph: null,
};

const BUILTIN_GUMMY_RAINBOW: ScrollbarSkin = {
	id: "builtin-gummy-rainbow",
	displayName: "Gummy Rainbow",
	base: "gummy",
	colors: {
		accent: "var(--color-accent)",
		track: "transparent",
		eaten: "transparent",
	},
	size: 12,
	pacGlyph: null,
};

export const BUILTIN_SCROLLBAR_SKINS: ScrollbarSkin[] = [BUILTIN_CLASSIC, BUILTIN_SNAKE, BUILTIN_GUMMY_RAINBOW];
export const DEFAULT_SCROLLBAR_SKIN_ID = BUILTIN_CLASSIC.id;

/** Pure shape validation for a main-process unpacked skin zip. */
export function validateImportedSkin(raw: unknown): ScrollbarSkin | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !r.id) return null;
	if (typeof r.displayName !== "string" || !r.displayName) return null;
	const base = r.base === "pacman" ? "pacman" : "gummy";
	const colors = (typeof r.colors === "object" && r.colors !== null ? r.colors : {}) as Record<string, unknown>;
	// Colour values land in CSS custom properties, so a value that can fetch
	// (url(), image()) is a network/execution surface, not a colour. Refuse it
	// and fall back instead of injecting whatever the zip contains.
	const color = (value: unknown, fallback: string): string =>
		typeof value === "string" && value && !/url\s*\(|image[-\w]*\s*\(|expression\s*\(/i.test(value)
			? value
			: fallback;
	const accent = color(colors.accent, BUILTIN_SNAKE.colors.accent);
	const track = color(colors.track, BUILTIN_SNAKE.colors.track);
	const eaten = color(colors.eaten, BUILTIN_SNAKE.colors.eaten);
	const size = typeof r.size === "number" && Number.isFinite(r.size) ? clampWidth(r.size) : BUILTIN_CLASSIC.size;
	const pacGlyph = typeof r.pacGlyph === "string" && r.pacGlyph.startsWith("data:") ? r.pacGlyph : null;
	return {
		id: r.id,
		displayName: r.displayName,
		base,
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
		return parsed.map(s => validateImportedSkin(s)).filter((s): s is ScrollbarSkin => s !== null);
	} catch {
		return [];
	}
}

/**
 * Skins contributed by Cordis plugins (`registerScrollbarSkin`). The host
 * publishes this module as `window.MusePiHostModules["scrollbar-skins"]`, so a
 * compiled bundle and the host settings picker read the SAME list instead of
 * each owning a copy.
 */
let contributedSkins: ScrollbarSkin[] = [];

/** Replace the contributed catalog; a changed list notifies the picker. */
export function setContributedScrollbarSkins(skins: readonly ScrollbarSkin[]): void {
	const next = skins.map(skin => ({ ...skin }));
	if (JSON.stringify(next) === JSON.stringify(contributedSkins)) return;
	contributedSkins = next;
	window.dispatchEvent(new Event(SCROLLBAR_SKINS_CHANGED_EVENT));
}

/** Contributed → imported → built-in, first id wins (a plugin may override a
 *  built-in skin). */
export function getScrollbarSkins(): ScrollbarSkin[] {
	const seen = new Set<string>();
	const out: ScrollbarSkin[] = [];
	for (const skin of [...contributedSkins, ...readImportedSkins(), ...BUILTIN_SCROLLBAR_SKINS]) {
		if (seen.has(skin.id)) continue;
		seen.add(skin.id);
		out.push(skin);
	}
	return out;
}

/** Resolve a skin by id, falling back to the neutral classic capsule. */
export function getScrollbarSkin(id: string | null): ScrollbarSkin {
	const skins = getScrollbarSkins();
	return skins.find(s => s.id === id) ?? BUILTIN_CLASSIC;
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
	try {
		return localStorage.getItem(SCROLLBAR_STYLE_KEY) ?? DEFAULT_SCROLLBAR_SKIN_ID;
	} catch {
		return DEFAULT_SCROLLBAR_SKIN_ID;
	}
}

/** Palette names a skin may override on <html>; base.css resolves them into
 *  the per-element tint. */
const PALETTE_VARS = [
	"--mp-scrollbar-skin-bg-l1",
	"--mp-scrollbar-skin-bg-l2",
	"--mp-scrollbar-skin-hover-l1",
	"--mp-scrollbar-skin-hover-l2",
	"--mp-scrollbar-skin-width",
	"--mp-scrollbar-skin-border",
] as const;

/**
 * Apply the selected skin to the document.
 *
 * A built-in is pure CSS: the attribute selects its palette block and recipe.
 * An imported or contributed skin carries data, not a stylesheet, so its
 * palette is written inline on <html> — the same names the CSS blocks set — and
 * the attribute only matters when its id happens to match a built-in recipe.
 */
export function applyScrollbarSkin(id: string | null, root: HTMLElement = document.documentElement): void {
	const skin = getScrollbarSkin(id);
	for (const name of PALETTE_VARS) root.style.removeProperty(name);
	root.dataset.scrollbarSkin = skin.id;
	if (BUILTIN_SCROLLBAR_SKINS.includes(skin)) return;
	const accent = skin.colors.accent;
	root.style.setProperty("--mp-scrollbar-skin-bg-l1", accent);
	root.style.setProperty("--mp-scrollbar-skin-bg-l2", `color-mix(in oklab, ${accent} 84%, white)`);
	root.style.setProperty("--mp-scrollbar-skin-hover-l1", `color-mix(in oklab, ${accent} 88%, white)`);
	root.style.setProperty("--mp-scrollbar-skin-hover-l2", `color-mix(in oklab, ${accent} 76%, white)`);
	root.style.setProperty("--mp-scrollbar-skin-width", `${clampWidth(skin.size)}px`);
}
