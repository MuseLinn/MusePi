/**
 * Lightweight i18n for the OMP stats dashboard (mirrors desktop-web).
 *
 * Translation keys ARE the English strings (pass-through for en-US).
 * `t()` must only be called at render time, never at module load time.
 */

import { zhCN } from "./zh-CN";

/** Translation map: English source string → localized string. */
export type TranslationMap = Record<string, string>;

// ── Locale registry ──────────────────────────────────────────────────────────

const locales: Record<string, TranslationMap> = {
	"zh-CN": zhCN,
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

// React re-render trigger: a simple version counter that increments on locale change.
let localeVersion = 0;
const listeners = new Set<() => void>();

function emit(): void {
	localeVersion++;
	for (const listener of listeners) {
		listener();
	}
}

/** Set locale at runtime (e.g., from the language toggle). */
export function setLocale(locale: string): void {
	if (currentLocale === locale) return;
	currentLocale = locale;
	try {
		globalThis.localStorage.setItem("omp.stats.locale", locale);
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
 * @param args - optional positional replacements ({0}, {1}, …)
 */
export function t(key: string, ...args: string[]): string {
	const locale = locales[currentLocale];
	let translated = locale?.[key] ?? key;
	if (args.length > 0) {
		for (let i = 0; i < args.length; i++) {
			translated = translated.replace(`{${i}}`, args[i]);
		}
	}
	return translated;
}

// ── Initialization ───────────────────────────────────────────────────────────

// Restore a persisted locale before the first render. Runs at module import,
// which precedes React's first paint (mirrors desktop-web's root init).
try {
	const stored = globalThis.localStorage.getItem("omp.stats.locale");
	if (stored === "zh-CN" || stored === "en-US") {
		setLocale(stored);
	}
} catch {
	// storage unavailable — use detected locale
}
