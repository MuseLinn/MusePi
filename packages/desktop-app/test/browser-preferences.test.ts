import "./happy-dom-shim";
import { beforeEach, describe, expect, it } from "bun:test";
import {
	BROWSER_PREFERENCES_CHANGED_EVENT,
	readBrowserSettingsTab,
	readBrowserShowFullUrl,
	writeBrowserSettingsTab,
	writeBrowserShowFullUrl,
} from "../src/lib/browser-preferences";

const KEYS = ["musepi-gui-browser-settings-tab", "musepi-gui-browser-show-full-url"];

beforeEach(() => {
	for (const key of KEYS) window.localStorage.removeItem(key);
});

describe("browser preferences", () => {
	it("uses backward-compatible defaults and rejects corrupt stored values", () => {
		expect(readBrowserSettingsTab()).toBe("general");
		expect(readBrowserShowFullUrl()).toBe(true);

		window.localStorage.setItem("musepi-gui-browser-settings-tab", "unknown");
		window.localStorage.setItem("musepi-gui-browser-show-full-url", "maybe");
		expect(readBrowserSettingsTab()).toBe("general");
		expect(readBrowserShowFullUrl()).toBe(true);
	});

	it("round-trips every settings view and the full-URL preference", () => {
		for (const tab of ["extensions", "data", "general"] as const) {
			writeBrowserSettingsTab(tab);
			expect(readBrowserSettingsTab()).toBe(tab);
		}
		writeBrowserShowFullUrl(false);
		expect(readBrowserShowFullUrl()).toBe(false);
		writeBrowserShowFullUrl(true);
		expect(readBrowserShowFullUrl()).toBe(true);
	});

	it("announces preference writes so an already-mounted browser updates", () => {
		const details: unknown[] = [];
		const onChange = (event: Event): void => details.push((event as CustomEvent).detail);
		window.addEventListener(BROWSER_PREFERENCES_CHANGED_EVENT, onChange);
		writeBrowserSettingsTab("extensions");
		writeBrowserShowFullUrl(false);
		window.removeEventListener(BROWSER_PREFERENCES_CHANGED_EVENT, onChange);
		expect(details).toEqual([
			{ key: "settingsTab", value: "extensions" },
			{ key: "showFullUrl", value: false },
		]);
	});
});
