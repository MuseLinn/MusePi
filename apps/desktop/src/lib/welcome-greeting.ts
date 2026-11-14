export const WELCOME_GREETING_STORAGE_KEY = "musepi-gui-welcome-greeting";
export const WELCOME_GREETING_CHANGED_EVENT = "musepi-welcome-greeting-changed";

export function readWelcomeGreeting(): string {
	try {
		return localStorage.getItem(WELCOME_GREETING_STORAGE_KEY) ?? "";
	} catch {
		return "";
	}
}

export function writeWelcomeGreeting(value: string): void {
	try {
		localStorage.setItem(WELCOME_GREETING_STORAGE_KEY, value);
	} catch {
		// The controlled input still reflects this session when storage is unavailable.
	}
	window.dispatchEvent(new CustomEvent(WELCOME_GREETING_CHANGED_EVENT));
}

/** A non-blank custom greeting wins; otherwise the time-aware default remains. */
export function resolveWelcomeGreeting(value: string, fallback: string): string {
	return value.trim() || fallback;
}
