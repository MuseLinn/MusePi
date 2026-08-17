import { useSyncExternalStore } from "react";

export type SystemTheme = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";
/** Accent axis — orthogonal to the scheme, like opencode's data-theme ×
 *  data-color-scheme split. Each preset carries its own light/dark pair and
 *  an accent foreground derived from the scheme (never a fixed color).
 *  "custom" applies a user-picked color with derived companions. */
export type AccentPreference = "brand" | "mono" | "ocean" | "jade" | "custom";

const STORAGE_KEY = "omp-collab-theme";
const ACCENT_STORAGE_KEY = "omp-collab-accent";
const CUSTOM_ACCENT_STORAGE_KEY = "omp-collab-accent-custom";
const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

function readStoredPreference(): ThemePreference {
	try {
		const stored = globalThis.localStorage.getItem(STORAGE_KEY);
		return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
	} catch {
		// Private-mode or blocked storage: fall back to following the system.
		return "system";
	}
}

function getSystemTheme(): SystemTheme {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia(DARK_SCHEME_QUERY).matches ? "dark" : "light";
}

// Module-level store shared by the toggle (writer) and any reader so an explicit
// override and the system default resolve through one source.
let preference: ThemePreference = readStoredPreference();
let resolved: SystemTheme = preference === "system" ? getSystemTheme() : preference;
const listeners = new Set<() => void>();

/* ── UI theme axis: separate LIGHT and DARK theme picks (openchamber /
 *    opencode parity). Orthogonal to the scheme and the accent: the active
 *    `data-ui-theme` id is resolved per scheme, and tokens.css scopes each
 *    preset's overrides under [data-theme="light"|"dark"]. "default" is the
 *    base scheme palette (no overrides). Declared before applyResolvedTheme
 *    so the module-init apply call sees initialized state (no TDZ). ── */

export type UiThemeId =
	| "default"
	| "warm"
	| "cool"
	| "midnight"
	| "graphite"
	| "anthro"
	| "openchamber"
	| "catppuccin"
	| "nord"
	| "tokyonight"
	| "aura"
	| "ayu"
	| "dracula"
	| "gruvbox"
	| "kanagawa"
	| "monokai"
	| "solarized"
	| "vesper";

const PAIRED: ReadonlyArray<{ id: UiThemeId; label: string }> = [
	{ id: "anthro", label: "Anthropic" },
	{ id: "openchamber", label: "OpenChamber" },
	{ id: "catppuccin", label: "Catppuccin" },
	{ id: "nord", label: "Nord" },
	{ id: "tokyonight", label: "Tokyo Night" },
	{ id: "aura", label: "Aura" },
	{ id: "ayu", label: "Ayu" },
	{ id: "dracula", label: "Dracula" },
	{ id: "gruvbox", label: "Gruvbox" },
	{ id: "kanagawa", label: "Kanagawa" },
	{ id: "monokai", label: "Monokai" },
	{ id: "solarized", label: "Solarized" },
	{ id: "vesper", label: "Vesper" },
];

export const LIGHT_THEME_PRESETS: ReadonlyArray<{ id: UiThemeId; label: string }> = [
	{ id: "default", label: "Default" },
	{ id: "warm", label: "Warm" },
	{ id: "cool", label: "Cool" },
	...PAIRED,
];

export const DARK_THEME_PRESETS: ReadonlyArray<{ id: UiThemeId; label: string }> = [
	{ id: "default", label: "Default" },
	{ id: "midnight", label: "Midnight" },
	{ id: "graphite", label: "Graphite" },
	...PAIRED,
];

/** Themes with BOTH a light and a dark variant — available in unified mode,
 *  where one pick drives both schemes (each variant has its own token block
 *  in tokens.css, so following-system switches apply the right one). */
export const UNIFIED_THEME_PRESETS: ReadonlyArray<{ id: UiThemeId; label: string }> = [
	{ id: "default", label: "Default" },
	...PAIRED,
];

const LIGHT_THEME_STORAGE_KEY = "omp-collab-ui-theme-light";
const DARK_THEME_STORAGE_KEY = "omp-collab-ui-theme-dark";
/** Unified-mode state: "1" = one theme drives both schemes; otherwise the
 *  separate light/dark picks apply. */
const UNIFIED_MODE_KEY = "omp-collab-ui-theme-unified-mode";
const UNIFIED_THEME_KEY = "omp-collab-ui-theme-unified";

function readStoredUiTheme(key: string, presets: ReadonlyArray<{ id: UiThemeId; label: string }>): UiThemeId {
	try {
		const stored = globalThis.localStorage.getItem(key);
		return presets.some(p => p.id === stored) ? (stored as UiThemeId) : "default";
	} catch {
		return "default";
	}
}

let lightThemeId: UiThemeId = readStoredUiTheme(LIGHT_THEME_STORAGE_KEY, LIGHT_THEME_PRESETS);
let darkThemeId: UiThemeId = readStoredUiTheme(DARK_THEME_STORAGE_KEY, DARK_THEME_PRESETS);
let unifiedMode: boolean = readStoredFlag(UNIFIED_MODE_KEY);
let unifiedThemeId: UiThemeId = readStoredUiTheme(UNIFIED_THEME_KEY, UNIFIED_THEME_PRESETS);
const uiThemeListeners = new Set<() => void>();

function readStoredFlag(key: string): boolean {
	try {
		return globalThis.localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

/** Mirror the scheme-resolved theme pick onto `data-ui-theme`. Unified mode
 *  resolves one theme id that has both variants; separate mode picks per
 *  scheme (light/dark stores). */
function applyUiTheme(): void {
	if (typeof document === "undefined") return;
	const id = unifiedMode ? unifiedThemeId : resolved === "light" ? lightThemeId : darkThemeId;
	document.documentElement.dataset.uiTheme = id;
}

function emitUiTheme(): void {
	for (const listener of uiThemeListeners) listener();
}

function subscribeUiTheme(callback: () => void): () => void {
	uiThemeListeners.add(callback);
	return () => uiThemeListeners.delete(callback);
}

function setUiThemeId(next: UiThemeId, key: string, store: (v: UiThemeId) => void): void {
	store(next);
	try {
		globalThis.localStorage.setItem(key, next);
	} catch {
		// Persistence is best-effort; still apply/emit the in-memory preference.
	}
	applyUiTheme();
	emitUiTheme();
}

/** Reader + writer for the theme axis: separate light/dark picks, plus the
 *  unified mode (one theme across both schemes) and its pick. */
export function useUiThemePreferences(): {
	lightThemeId: UiThemeId;
	darkThemeId: UiThemeId;
	setLightTheme: (next: UiThemeId) => void;
	setDarkTheme: (next: UiThemeId) => void;
	unifiedMode: boolean;
	unifiedThemeId: UiThemeId;
	setUnifiedMode: (next: boolean) => void;
	setUnifiedTheme: (next: UiThemeId) => void;
} {
	const light = useSyncExternalStore(
		subscribeUiTheme,
		() => lightThemeId,
		() => "default" as UiThemeId,
	);
	const dark = useSyncExternalStore(
		subscribeUiTheme,
		() => darkThemeId,
		() => "default" as UiThemeId,
	);
	const unified = useSyncExternalStore(
		subscribeUiTheme,
		() => unifiedMode,
		() => false,
	);
	const unifiedId = useSyncExternalStore(
		subscribeUiTheme,
		() => unifiedThemeId,
		() => "default" as UiThemeId,
	);
	return {
		lightThemeId: light,
		darkThemeId: dark,
		setLightTheme: next => setUiThemeId(next, LIGHT_THEME_STORAGE_KEY, v => (lightThemeId = v)),
		setDarkTheme: next => setUiThemeId(next, DARK_THEME_STORAGE_KEY, v => (darkThemeId = v)),
		unifiedMode: unified,
		unifiedThemeId: unifiedId,
		setUnifiedMode: next => {
			unifiedMode = next;
			try {
				globalThis.localStorage.setItem(UNIFIED_MODE_KEY, next ? "1" : "0");
			} catch {
				// best-effort persistence
			}
			applyUiTheme();
			emitUiTheme();
		},
		setUnifiedTheme: next => setUiThemeId(next, UNIFIED_THEME_KEY, v => (unifiedThemeId = v)),
	};
}

function emit(): void {
	for (const listener of listeners) listener();
}

function applyResolvedTheme(): void {
	resolved = preference === "system" ? getSystemTheme() : preference;
	if (typeof document !== "undefined") {
		// data-theme is the legacy knob (collab-web guest), data-color-scheme the
		// v2 orthogonal axis (kimi-code web naming) — keep both in sync.
		document.documentElement.dataset.theme = resolved;
		document.documentElement.dataset.colorScheme = resolved;
		document.documentElement.style.colorScheme = resolved;
		applyUiTheme();
		// Custom-accent companions (hover direction, readability) are
		// scheme-derived — re-derive when the scheme flips.
		applyAccent();
	}
}

/** Module init — deferred to the END of the file so every `let` store below
 *  (ui-theme axis, accent axis) is initialized before the first apply
 *  (accessing a later `let` from module scope would throw a TDZ error). */
function initThemeModule(): void {
	if (typeof window === "undefined") return;
	applyResolvedTheme();
	applyAccent();
	window.matchMedia(DARK_SCHEME_QUERY).addEventListener("change", () => {
		// System changes only move the needle while following the system.
		if (preference === "system") {
			applyResolvedTheme();
			emit();
		}
	});
}

export function setThemePreference(next: ThemePreference): void {
	preference = next;
	try {
		globalThis.localStorage.setItem(STORAGE_KEY, next);
	} catch {
		// Persistence is best-effort; still apply/emit the in-memory preference.
	}
	applyResolvedTheme();
	emit();
}

function subscribe(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

/** Reader for the active resolved theme. Reflects system default and overrides. */
export function useSystemTheme(): SystemTheme {
	return useSyncExternalStore(
		subscribe,
		() => resolved,
		() => "dark" as SystemTheme,
	);
}

/** Reader + writer for the theme preference (powers the toggle). */
export function useThemePreference(): {
	preference: ThemePreference;
	resolved: SystemTheme;
	setPreference: (next: ThemePreference) => void;
} {
	const pref = useSyncExternalStore(
		subscribe,
		() => preference,
		() => "system" as ThemePreference,
	);
	const res = useSyncExternalStore(
		subscribe,
		() => resolved,
		() => "dark" as SystemTheme,
	);
	return { preference: pref, resolved: res, setPreference: setThemePreference };
}

/* ── Accent axis — orthogonal to the scheme; recolours only the accent. ── */

function readStoredAccent(): AccentPreference {
	try {
		const stored = globalThis.localStorage.getItem(ACCENT_STORAGE_KEY);
		return stored === "mono" || stored === "ocean" || stored === "jade" || stored === "custom" ? stored : "brand";
	} catch {
		return "brand";
	}
}

/** Default custom accent = the brand emerald, so the picker never opens empty. */
const DEFAULT_CUSTOM_ACCENT = "#34d399";

function normalizeHex(input: string): string | null {
	const match = /^#?([0-9a-f]{6})$/i.exec(input.trim());
	return match ? `#${match[1]!.toLowerCase()}` : null;
}

function readStoredCustomAccent(): string {
	try {
		return normalizeHex(globalThis.localStorage.getItem(CUSTOM_ACCENT_STORAGE_KEY) ?? "") ?? DEFAULT_CUSTOM_ACCENT;
	} catch {
		return DEFAULT_CUSTOM_ACCENT;
	}
}

function hexToRgb(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
	const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
	return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

function withAlphaHex(hex: string, alpha: number): string {
	return `${hex}${Math.round(alpha * 255)
		.toString(16)
		.padStart(2, "0")}`;
}

/** WCAG relative luminance of an sRGB color (0 = black, 1 = white). */
function relativeLuminance(r: number, g: number, b: number): number {
	const channel = (v: number): number => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Derive the full accent family from a single custom color. Mirrors the
 * preset blocks in tokens.css: muted = 18% alpha, border = 35%, hover
 * lightens in the dark scheme / darkens in light (presets do the same),
 * and the on-accent foreground flips by luminance so it stays readable.
 */
function deriveCustomAccent(hex: string, scheme: SystemTheme): Record<string, string> {
	const [r, g, b] = hexToRgb(hex);
	const hover =
		scheme === "dark"
			? rgbToHex(r + (255 - r) * 0.12, g + (255 - g) * 0.12, b + (255 - b) * 0.12)
			: rgbToHex(r * 0.85, g * 0.85, b * 0.85);
	return {
		"--accent": hex,
		"--accent-fg": relativeLuminance(r, g, b) > 0.45 ? "#17151a" : "#fdfdfd",
		"--accent-muted": withAlphaHex(hex, 0.18),
		"--accent-hover": hover,
		"--accent-bd": withAlphaHex(hex, 0.35),
		"--brand-mark-gradient": `linear-gradient(135deg, ${hex} 0%, ${rgbToHex(r * 0.72, g * 0.72, b * 0.72)} 100%)`,
	};
}

const ACCENT_INLINE_VARS = [
	"--accent",
	"--accent-fg",
	"--accent-muted",
	"--accent-hover",
	"--accent-bd",
	"--brand-mark-gradient",
] as const;

let accent: AccentPreference = readStoredAccent();
let customAccent: string = readStoredCustomAccent();
const accentListeners = new Set<() => void>();

function emitAccent(): void {
	for (const listener of accentListeners) listener();
}

function applyAccent(): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (accent === "custom") {
		root.dataset.accent = "custom";
		const tokens = deriveCustomAccent(customAccent, resolved);
		for (const [name, value] of Object.entries(tokens)) {
			root.style.setProperty(name, value);
		}
	} else {
		root.dataset.accent = accent;
		// Drop inline overrides so the preset blocks in tokens.css win again.
		for (const name of ACCENT_INLINE_VARS) {
			root.style.removeProperty(name);
		}
	}
}

export function setAccentPreference(next: AccentPreference): void {
	accent = next;
	try {
		globalThis.localStorage.setItem(ACCENT_STORAGE_KEY, next);
	} catch {
		// Persistence is best-effort; still apply/emit the in-memory preference.
	}
	applyAccent();
	emitAccent();
}

/** Pick a custom accent color; switches the accent axis to "custom". */
export function setCustomAccentColor(input: string): void {
	const hex = normalizeHex(input);
	if (!hex) return;
	customAccent = hex;
	try {
		globalThis.localStorage.setItem(CUSTOM_ACCENT_STORAGE_KEY, hex);
	} catch {
		// Persistence is best-effort; still apply/emit the in-memory preference.
	}
	if (accent === "custom") {
		applyAccent();
	}
	emitAccent();
}

function subscribeAccent(callback: () => void): () => void {
	accentListeners.add(callback);
	return () => accentListeners.delete(callback);
}

/** Reader + writer for the accent preference (presets + custom color). */
export function useAccentPreference(): {
	accent: AccentPreference;
	customAccent: string;
	setAccent: (next: AccentPreference) => void;
	setCustomAccent: (next: string) => void;
} {
	const value = useSyncExternalStore(
		subscribeAccent,
		() => accent,
		() => "brand" as AccentPreference,
	);
	const custom = useSyncExternalStore(
		subscribeAccent,
		() => customAccent,
		() => DEFAULT_CUSTOM_ACCENT,
	);
	return {
		accent: value,
		customAccent: custom,
		setAccent: setAccentPreference,
		setCustomAccent: setCustomAccentColor,
	};
}

export const ACCENT_PRESETS: ReadonlyArray<{ id: AccentPreference; label: string }> = [
	{ id: "brand", label: "Brand pink" },
	{ id: "mono", label: "Mono" },
	{ id: "ocean", label: "Ocean blue" },
	{ id: "jade", label: "Jade green" },
];

initThemeModule();
