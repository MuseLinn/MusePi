/**
 * Lightweight i18n for desktop-web.
 *
 * Translation keys ARE the English strings (pass-through for en-US).
 * `t()` must only be called at render time, never at module load time.
 */

import { enUS } from "./en-US/index.js";
import { zhCN } from "./zh-CN/index.js";

/** Translation map: English source string → localized string. */
export type TranslationMap = Record<string, string>;

/**
 * Typed translation keys: every `t()` key must exist in zh-CN.ts
 * (English pass-through = key itself). Typos are compile errors.
 */
export type TranslationKey = keyof typeof zhCN;

/**
 * Extract `{name}` placeholders from a translated template into a params
 * contract, so `t("… {count} …", { count })` is checked at compile time.
 */
type PlaceholderOf<S extends string> = S extends `${string}{${infer N}}${infer R}`
	? N extends string
		? N | PlaceholderOf<R>
		: never
	: never;

/** Params type for a key: `{ count: string | number }` when the template has placeholders, else `{}`. */
export type ParamsOf<K extends TranslationKey> = [PlaceholderOf<(typeof zhCN)[K]>] extends [never]
	? Record<string, never>
	: { [P in PlaceholderOf<(typeof zhCN)[K]>]: string | number };

// ── Locale registry ──────────────────────────────────────────────────────────

const locales: Record<string, TranslationMap> = {
	"zh-CN": zhCN,
	"en-US": enUS,
};

let currentLocale = detectLocale();

function detectLocale(): string {
	if (typeof navigator !== "undefined") {
		const nav = navigator as Navigator;
		const lang = typeof nav.language === "string" ? nav.language.toLowerCase() : "";
		if (lang.startsWith("zh")) return "zh-CN";
	}
	return "en-US";
}

const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) {
		listener();
	}
}

/** Set locale at runtime (e.g., from settings change). */
export function setLocale(locale: string): void {
	if (currentLocale === locale) return;
	const doc = globalThis.document as (Document & { startViewTransition?: (cb: () => void) => void }) | undefined;
	const swap = (): void => {
		currentLocale = locale;
		try {
			globalThis.localStorage.setItem("omp.collab.locale", locale);
		} catch {
			// storage unavailable — non-fatal
		}
		emit();
	};
	if (doc?.startViewTransition) {
		// Whole-UI cross-fade on language switch — text would snap without
		// it (View Transitions API, Chromium 111+; safe no-op elsewhere).
		doc.startViewTransition(swap);
	} else {
		swap();
	}
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function subscribeLocale(callback: () => void): () => void {
	listeners.add(callback);
	return () => listeners.delete(callback);
}

/** Snapshot of the current locale for useSyncExternalStore. */
export function getLocaleSnapshot(): string {
	return currentLocale;
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * Core translation lookup: `key` → current locale map, falling back to the
 * key itself (English source string). Named `{name}` replacements applied
 * when params are given.
 */
function translate(key: string, params?: Record<string, string | number>): string {
	const locale = locales[currentLocale];
	let translated = locale?.[key] ?? key;
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			translated = translated.split(`{${name}}`).join(String(value));
		}
	}
	return translated;
}

/**
 * Translate `key` for the current locale.
 * Falls back to the key itself if no translation is found.
 *
 * @param key - English source string (also the translation key)
 * @param params - optional named replacements ({count}, {name}, …)
 */
export function t<K extends TranslationKey>(key: K, params?: ParamsOf<K>): string {
	return translate(key, params);
}

/**
 * Loose `t` for plugin-originated keys that are not (yet) in the core
 * zh-CN map — e.g. strings contributed via {@link registerTranslations}.
 * Plugin components calling `t()` with their own keys need this (or an
 * explicit `as TranslationKey` cast) since `t` only accepts core keys.
 */
export function tLoose(key: string, params?: Record<string, string | number>): string {
	return translate(key, params);
}

/**
 * Register (or override) translations for a locale at runtime — the seam
 * for plugins / host apps contributing UI strings. Overlays the base map:
 * existing keys are replaced, new keys are added. Emits so live UI
 * re-renders when the current locale is affected. Not persisted — a reload
 * restores the core maps.
 */
export function registerTranslations(locale: string, map: Record<string, string>): void {
	const base = locales[locale] ?? {};
	locales[locale] = { ...base, ...map };
	if (locale === currentLocale) emit();
}

// ── Initialization ───────────────────────────────────────────────────────────

try {
	const stored = globalThis.localStorage.getItem("omp.collab.locale");
	if (stored === "zh-CN" || stored === "en-US") {
		setLocale(stored);
	}
} catch {
	// storage unavailable — use detected locale
}

// Re-detect when the OS/browser language changes while the page is open, so
// locale switches take effect without a reload (detectLocale ran at module
// load and would otherwise stay stale).
if (typeof window !== "undefined") {
	window.addEventListener("languagechange", () => {
		const next = detectLocale();
		if (next !== currentLocale) setLocale(next);
	});
}
