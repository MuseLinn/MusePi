// ============================================================
// MusePi i18n — lightweight locale system.
//
// `t()` lookup with dynamic locale switching. No dependencies,
// zero runtime cost when locale is en-US (passes through keys).
// ============================================================

export type Locale = "en-US" | "zh-CN";

/** Translation map: key → localized string. */
export type TranslationMap = Record<string, string>;

const locales = new Map<Locale, TranslationMap>();
let currentLocale: Locale = "en-US";

/** Register a locale's translations. Called once per locale at module init. */
export function registerLocale(locale: Locale, map: TranslationMap): void {
	locales.set(locale, map);
}

/** Set the active locale. Returns the previous locale. */
export function setLocale(locale: Locale): Locale {
	const prev = currentLocale;
	currentLocale = locale;
	return prev;
}

/** Get the active locale. */
export function getLocale(): Locale {
	return currentLocale;
}

/** Look up a localized string by key. Falls back to the key itself (en-US pass-through). */
export function t(key: string): string {
	const map = locales.get(currentLocale);
	if (!map) return key;
	return map[key] ?? key;
}

// Auto-register zh-CN on import
import { zhCN } from "./zh-CN.ts";
registerLocale("zh-CN", zhCN);
