import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MobileSettings } from "../src/components/shell/MobileSettings";
import { readMobilePref, writeMobilePref } from "../src/lib/mobile-prefs";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let mountedRoot: Root | null = null;

afterAll(() => {
	GlobalRegistrator.unregister();
});

afterEach(async () => {
	// Every root this file mounts stays subscribed to the i18n store, and
	// `bun test` runs all files in one process — an unmounted root would
	// re-render into a window this file unregistered, breaking the next
	// file's setLocale(). Dispose before clearing the DOM.
	if (mountedRoot) await act(async () => mountedRoot?.unmount());
	mountedRoot = null;
	localStorage.clear();
	document.body.innerHTML = "";
	delete (window as unknown as { harmonyNative?: unknown }).harmonyNative;
	delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

async function renderSettings(): Promise<HTMLDivElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mountedRoot = root;
	mountedRoot = root;
	await act(async () => {
		root.render(createElement(MobileSettings, {}));
	});
	return host;
}

describe("mobile settings sections", () => {
	it("renders notifications, storage and about without a live session", async () => {
		const host = await renderSettings();
		const text = host.textContent ?? "";
		// These three sections must exist while nothing is connected: the moment
		// a user needs storage or diagnostics is right after a failed connect.
		// Asserted through the rendered copy because the suite's default locale
		// is English — a Chinese literal here would pin the test to `zh-CN`.
		expect(text).toContain("Notifications");
		expect(text).toContain("Storage & privacy");
		expect(text).toContain("About");
		expect(text).toContain("Cache used");
	});

	it("tells a browser that local notifications are unavailable", async () => {
		// No Capacitor bridge in this harness: the section must say so rather
		// than offer switches that silently do nothing.
		const host = await renderSettings();
		expect(host.textContent ?? "").toContain("This shell has no local notifications");
	});

	it("exposes the notification switches as accessible switches", async () => {
		const host = await renderSettings();
		const switches = host.querySelectorAll('[role="switch"]');
		expect(switches.length).toBe(2);
		for (const node of switches) {
			expect(node.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
			expect(node.getAttribute("aria-checked")).toBe("true");
		}
	});

	it("stages the destructive clear behind a confirmation", async () => {
		const host = await renderSettings();
		const before = host.querySelector('[role="alertdialog"]');
		expect(before).toBeNull();
		const clearAll = [...host.querySelectorAll("button")].find(node =>
			node.textContent?.includes("Clear all local data"),
		);
		expect(clearAll).toBeDefined();
		await act(async () => {
			clearAll?.click();
		});
		const dialog = host.querySelector('[role="alertdialog"]');
		expect(dialog).not.toBeNull();
		// The confirm names the consequence instead of a bare "are you sure".
		expect(dialog?.textContent ?? "").toContain("Saved computers");
	});
});

describe("mobile preferences", () => {
	it("defaults when nothing was stored", () => {
		expect(readMobilePref("notifyOnFinish", true)).toBe(true);
		expect(readMobilePref("notifyOnAsk", false)).toBe(false);
	});

	it("round-trips through localStorage", () => {
		writeMobilePref("notifyOnFinish", false);
		expect(readMobilePref("notifyOnFinish", true)).toBe(false);
		writeMobilePref("notifyOnFinish", true);
		expect(readMobilePref("notifyOnFinish", false)).toBe(true);
	});

	it("mirrors the write to the HarmonyOS shell store", () => {
		const writes: Array<{ key: string; value: string }> = [];
		(window as unknown as { harmonyNative?: unknown }).harmonyNative = {
			setPref: (key: string, value: string) => writes.push({ key, value }),
		};
		writeMobilePref("notifyOnAsk", false);
		// One write path, two stores: this is the split-brain fix — a page toggle
		// that only wrote localStorage would be invisible to the native row.
		expect(writes).toEqual([{ key: "notifyOnAsk", value: "0" }]);
		expect(readMobilePref("notifyOnAsk", true)).toBe(false);
	});
});
