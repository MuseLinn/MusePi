/**
 * One write path for mobile-only preferences.
 *
 * The page and the HarmonyOS shell have both persisted preferences since the
 * native settings page landed, and the resulting split-brain is recorded in
 * `docs/mobile-app-redesign.md` §4.4: the page pushed its own scheme at boot
 * and overwrote the shell's stored light theme. The rule that came out of it
 * is "the shell is the only writer" — but the shell cannot own preferences the
 * page invents, so the reverse case needs the same care: a page-side toggle
 * that only wrote `localStorage` would be invisible to the native settings row
 * that shows the same switch.
 *
 * This module is therefore the page's side of that contract: every write goes
 * to `localStorage` (the browser's only store) AND through `setPref`, so a
 * shell that mirrors these keys sees the change immediately. Reads prefer the
 * value the shell already holds, because on a shell the shell's store is
 * authoritative and `localStorage` may be a stale first-launch migration.
 */

import { isHarmonyShell } from "./capacitor";

/** Preferences that exist only on the phone-shaped surface. */
export type MobilePrefKey = "notifyOnFinish" | "notifyOnAsk";

function storageKey(key: MobilePrefKey): string {
	return `musepi-mobile-${key}`;
}

/** Read a boolean preference; `fallback` when nothing was ever stored. */
export function readMobilePref(key: MobilePrefKey, fallback: boolean): boolean {
	try {
		const stored = localStorage.getItem(storageKey(key));
		if (stored === "0") return false;
		if (stored === "1") return true;
	} catch {
		// storage unavailable (private mode) — the fallback stands
	}
	return fallback;
}

/**
 * Persist a boolean preference in both stores.
 *
 * The shell write is attempted first: when the shell owns the store, a failure
 * there means the preference will not survive a restart, and silently writing
 * only `localStorage` would hide that from the caller.
 */
export function writeMobilePref(key: MobilePrefKey, value: boolean): void {
	const raw = value ? "1" : "0";
	try {
		localStorage.setItem(storageKey(key), raw);
	} catch {
		// storage unavailable — the in-memory state still applies this session
	}
	if (isHarmonyShell()) {
		try {
			window.harmonyNative?.setPref?.(key, raw);
		} catch {
			// bridge missing — localStorage remains the record
		}
	}
}
