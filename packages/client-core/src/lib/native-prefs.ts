import { setLocale } from "../i18n/index.js";
import { isHarmonyShell } from "./capacitor";
import { cssColorToHex } from "./color";
import { readVersionedOneOf } from "./storage-keys";
import {
	ACCENT_KEY,
	ACCENT_PRESETS,
	type AccentPreference,
	setAccentPreference,
	setThemePreference,
	THEME_KEY,
	type ThemePreference,
} from "./theme";

const FONT_SCALE_KEY = "musepi-gui-font-scale";
const MATERIAL_KEY = "musepi-tabbar-material";

/** Preference keys the HarmonyOS shell owns. Kept in the shell's order
 *  (`common/prefs.ets`); a key the shell does not know is ignored on both sides. */
type NativePrefKey = "theme" | "accent" | "fontScale" | "locale" | "tabBarMaterial";

function isPrefKey(value: string): value is NativePrefKey {
	return (
		value === "theme" ||
		value === "accent" ||
		value === "fontScale" ||
		value === "locale" ||
		value === "tabBarMaterial"
	);
}

/**
 * Apply one preference that the native settings page changed.
 *
 * The page is still the renderer — it owns `data-theme`, `--accent`, the font
 * scale variable and the locale — so the shell writes through the same setters
 * the in-page controls use instead of setting attributes behind their backs.
 * That keeps one source of truth per preference: the store, with two writers.
 */
export function applyNativePref(key: string, value: string): void {
	if (!isPrefKey(key)) return;
	switch (key) {
		case "theme":
			setThemePreference(value as ThemePreference);
			break;
		case "accent":
			setAccentPreference(value as AccentPreference);
			break;
		case "fontScale": {
			if (value !== "13" && value !== "15" && value !== "17") return;
			document.documentElement.style.setProperty("--gui-font-scale", `${value}px`);
			try {
				localStorage.setItem(FONT_SCALE_KEY, value);
			} catch {
				// storage unavailable — the variable still applies this session
			}
			break;
		}
		case "locale":
			setLocale(value);
			break;
		case "tabBarMaterial": {
			try {
				localStorage.setItem(MATERIAL_KEY, value);
			} catch {
				// storage unavailable
			}
			try {
				window.harmonyNative?.setTabBarMaterial?.(Number(value));
			} catch {
				// bridge absent
			}
			break;
		}
	}
}

/**
 * The resolved colour of every accent preset, for the native swatch row.
 *
 * Each preset is previewed inside its own `data-accent` scope (plus the current
 * scheme attributes, because the light variants are scoped on the same
 * element), so the swatch a user taps is painted with the value that tap will
 * install — no duplicated palette in ArkTS.
 */
export function readAccentPalette(): string {
	const root = document.documentElement;
	const palette: Record<string, string> = {};
	const probe = document.createElement("div");
	probe.style.cssText = "position:absolute;visibility:hidden;width:0;height:0;pointer-events:none";
	probe.dataset.theme = root.dataset.theme ?? "";
	if (root.dataset.colorScheme) probe.dataset.colorScheme = root.dataset.colorScheme;
	document.body.appendChild(probe);
	try {
		for (const preset of ACCENT_PRESETS) {
			probe.dataset.accent = preset.id;
			const hex = cssColorToHex(getComputedStyle(probe).getPropertyValue("--accent"));
			if (hex) palette[preset.id] = hex;
		}
	} finally {
		probe.remove();
	}
	return JSON.stringify(palette);
}

function pushPref(key: NativePrefKey, value: string): void {
	try {
		window.harmonyNative?.setPref?.(key, value);
	} catch {
		// bridge absent
	}
}

/** Current values the page holds, in the shell's vocabulary. */
function currentPrefs(): Record<NativePrefKey, string> {
	const root = document.documentElement;
	const theme = readVersionedOneOf(THEME_KEY, ["system", "light", "dark"] as const) ?? "system";
	const accent =
		readVersionedOneOf(
			ACCENT_KEY,
			ACCENT_PRESETS.map(p => p.id),
		) ?? "theme";
	const font = localStorage.getItem(FONT_SCALE_KEY);
	const locale = localStorage.getItem("omp.collab.locale");
	const material = localStorage.getItem(MATERIAL_KEY);
	return {
		theme,
		accent,
		fontScale: font === "13" || font === "17" ? font : "15",
		locale: locale?.toLowerCase().startsWith("en") ? "en-US" : "zh-CN",
		tabBarMaterial: material ?? "0",
	};
}

/**
 * Adopt whatever the shell has stored, or hand it the page's current values.
 *
 * Installing over an existing app must not reset the user's theme: the shell's
 * store starts empty on the first launch after this change, so an empty answer
 * means "migrate from the WebView", not "use defaults". A non-empty answer wins.
 */
export function syncNativePrefs(): void {
	if (!isHarmonyShell()) return;
	let stored: Record<string, string> = {};
	try {
		const raw = window.harmonyNative?.getPrefs?.() ?? "";
		if (raw) stored = JSON.parse(raw) as Record<string, string>;
	} catch {
		stored = {};
	}
	const keys = Object.keys(stored);
	if (keys.length === 0) {
		// First launch after this change: the shell has no record, so the page
		// hands over what it has been rendering. This is the one moment the page
		// is allowed to tell the shell its scheme — afterwards the shell owns it.
		const current = currentPrefs();
		for (const value of Object.entries(current)) pushPref(value[0] as NativePrefKey, value[1]);
		try {
			window.harmonyNative?.setThemeColor?.(document.documentElement.dataset.theme !== "light");
		} catch {
			// bridge absent
		}
	} else {
		for (const key of keys) applyNativePref(key, stored[key] ?? "");
	}
	pushAccentPalette();
}

/** Re-send the preset colours (scheme or accent changed). */
export function pushAccentPalette(): void {
	if (!isHarmonyShell()) return;
	try {
		window.harmonyNative?.setAccentPalette?.(readAccentPalette());
	} catch {
		// bridge absent
	}
}

/** Wire the shell's push channel. Returns the disposer. */
export function installNativePrefBridge(): () => void {
	if (!isHarmonyShell()) return () => {};
	const host = window as unknown as Record<string, unknown>;
	host.__musepiPref = (key: string, value: string): void => {
		applyNativePref(key, value);
		if (key === "accent" || key === "theme") pushAccentPalette();
	};
	return () => {
		delete host.__musepiPref;
	};
}
