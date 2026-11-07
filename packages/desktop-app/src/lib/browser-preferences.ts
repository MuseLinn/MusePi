export type BrowserSettingsTab = "general" | "extensions" | "data";

export const BROWSER_PREFERENCES_CHANGED_EVENT = "musepi-browser-preferences-changed";

const SETTINGS_TAB_KEY = "musepi-gui-browser-settings-tab";
const EXTENSIONS_TOOLBAR_KEY = "musepi-gui-browser-extensions-toolbar";
const SHOW_FULL_URL_KEY = "musepi-gui-browser-show-full-url";

function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string, detail: { key: string; value: string | boolean }): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		return;
	}
	window.dispatchEvent(new CustomEvent(BROWSER_PREFERENCES_CHANGED_EVENT, { detail }));
}

function readBoolean(key: string, fallback: boolean): boolean {
	const value = read(key);
	return value === "1" ? true : value === "0" ? false : fallback;
}

export function readBrowserSettingsTab(): BrowserSettingsTab {
	const value = read(SETTINGS_TAB_KEY);
	return value === "extensions" || value === "data" ? value : "general";
}

export function writeBrowserSettingsTab(tab: BrowserSettingsTab): void {
	write(SETTINGS_TAB_KEY, tab, { key: "settingsTab", value: tab });
}

export function readBrowserExtensionsToolbarVisible(): boolean {
	return readBoolean(EXTENSIONS_TOOLBAR_KEY, true);
}

export function writeBrowserExtensionsToolbarVisible(visible: boolean): void {
	write(EXTENSIONS_TOOLBAR_KEY, visible ? "1" : "0", { key: "extensionsToolbar", value: visible });
}

export function readBrowserShowFullUrl(): boolean {
	return readBoolean(SHOW_FULL_URL_KEY, true);
}

export function writeBrowserShowFullUrl(visible: boolean): void {
	write(SHOW_FULL_URL_KEY, visible ? "1" : "0", { key: "showFullUrl", value: visible });
}
