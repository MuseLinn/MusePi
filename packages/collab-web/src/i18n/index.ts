/**
 * Lightweight i18n for collab-web.
 *
 * Translation keys ARE the English strings (pass-through for en-US).
 * `t()` must only be called at render time, never at module load time.
 */

import { enUS } from "./en-US.js";
import { zhCN } from "./zh-CN.js";

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
	currentLocale = locale;
	try {
		globalThis.localStorage.setItem("omp.collab.locale", locale);
	} catch {
		// storage unavailable — non-fatal
	}
	emit();
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
 * Translate `key` for the current locale.
 * Falls back to the key itself if no translation is found.
 *
 * @param key - English source string (also the translation key)
 * @param params - optional named replacements ({count}, {name}, …)
 */
export function t<K extends TranslationKey>(key: K, params?: ParamsOf<K>): string {
	const locale = locales[currentLocale];
	let translated = locale?.[key] ?? key;
	if (params) {
		for (const [name, value] of Object.entries(params)) {
			translated = translated.split(`{${name}}`).join(String(value));
		}
	}
	return translated;
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
