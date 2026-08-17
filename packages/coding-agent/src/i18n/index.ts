/**
 * Lightweight i18n framework for MusePi.
 *
 * Usage:
 *   import { t } from "../i18n/index.js";
 *   t("Hello, {0}!", name);  // translates "Hello, {0}!" → 你好，{0}!
 *
 * Translation keys ARE the English strings (pass-through for en-US).
 * `t()` must only be called at render time, never at module load time.
 */

import { zhCN } from "./zh-CN.ts";

export type TranslationMap = Record<string, string>;

// ── Locale registry ──────────────────────────────────────────────────────────

const locales: Record<string, TranslationMap> = {
	"zh-CN": zhCN,
	"zh-CN-b5": zhCN, // fallback
};

/**
 * Current locale. `undefined` means "not yet resolved"; `t()` falls back
 * to `detectLocale()` in that case so render-time calls never block on
 * initialization order.
 */
let currentLocale: string | undefined;

/**
 * Resolve locale precedence without mutating global state:
 *   1. `settings.locale` (if provided by the caller)
 *   2. `LOCALE` / `MUSEPI_LOCALE` env vars
 *   3. System locale (`Intl.DateTimeFormat`)
 *   4. `"en-US"`
 */
function detectLocale(settingsLocale?: string | undefined): string {
	return (
		settingsLocale ??
		process.env.LOCALE ??
		process.env.MUSEPI_LOCALE ??
		Intl.DateTimeFormat().resolvedOptions().locale ??
		"en-US"
	);
}

/** Set locale at runtime (e.g., from settings change). */
export function setLocale(locale: string): void {
	currentLocale = locale;
}

/** Get the effective locale. Falls back to env/system if `setLocale()` was never called. */
export function getLocale(settingsLocale?: string | undefined): string {
	return currentLocale ?? detectLocale(settingsLocale);
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Translate `key` for the current locale.
 * Falls back to the key itself if no translation is found.
 *
 * @param key - English source string (also the translation key)
 * @param args - optional positional replacements ({0}, {1}, …)
 */
export function t(key: string, ...args: string[]): string {
	const locale = getLocale();
	const map = locales[locale];
	let translated = map?.[key] ?? key;
	if (args.length > 0) {
		for (let i = 0; i < args.length; i++) {
			translated = translated.replace(`{${i}}`, args[i]);
		}
	}
	return translated;
}
