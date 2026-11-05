import "./happy-dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getHostState, restoreTabs } from "../src/lib/managed-browser-host";
import { EMPTY_PANEL_TAB_STATE, serializePanelTabs, upsertPanelTab } from "../src/lib/panel-tabs";
import { type UsePanelTabsResult, usePanelTabs } from "../src/lib/use-panel-tabs";

/**
 * Persisted tabs written before the scheme rename must reach the renderer as
 * `musepi-file://`: the retired spelling is rejected by main, so migrating on
 * read (and writing the migrated record back) is what keeps old tabs alive
 * without ever rendering the old address.
 */

const TABS_KEY = "musepi-gui-managed-browser-tabs";
const LEGACY_PREFIX = /omp-file:\/\//i;

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	for (const host of hosts.splice(0)) host.remove();
	vi.restoreAllMocks();
	localStorage.clear();
});

function legacyHostRecord(url: string): string {
	return JSON.stringify({ v: 2, tabs: [{ url, sessionId: null, customTitle: null, muted: false }] });
}

function mountPanelProbe(storageKey: string): { current: UsePanelTabsResult | null } {
	const latest = { current: null as UsePanelTabsResult | null };
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);

	function Probe(): null {
		latest.current = usePanelTabs(storageKey);
		return null;
	}

	act(() => root.render(<Probe />));
	return latest;
}

describe("managed browser tab persistence migration", () => {
	it("rewrites legacy host tab URLs and stores the canonical record", () => {
		// The restored tab never attaches a guest here, so the attach deadline
		// must not keep a timer alive past the test.
		vi.spyOn(window, "setTimeout").mockImplementation((() => 0) as unknown as typeof window.setTimeout);
		localStorage.setItem(TABS_KEY, legacyHostRecord("omp-file://localhost/tmp/legacy.html"));

		restoreTabs();

		const stored = localStorage.getItem(TABS_KEY) ?? "";
		expect(stored).not.toMatch(LEGACY_PREFIX);
		expect(JSON.parse(stored).tabs[0].url).toBe("musepi-file://localhost/tmp/legacy.html");
		expect(getHostState().tabs.map(tab => tab.url)).toContain("musepi-file://localhost/tmp/legacy.html");
	});

	it("keeps canonical host tab URLs untouched", () => {
		vi.spyOn(window, "setTimeout").mockImplementation((() => 0) as unknown as typeof window.setTimeout);
		localStorage.setItem(TABS_KEY, legacyHostRecord("musepi-file://localhost/tmp/current.html"));

		restoreTabs();

		expect(JSON.parse(localStorage.getItem(TABS_KEY) ?? "").tabs[0].url).toBe(
			"musepi-file://localhost/tmp/current.html",
		);
	});
});

describe("panel tab persistence migration", () => {
	it("renders a legacy panel tab target as the canonical scheme", () => {
		const storageKey = "musepi-gui-panel-tabs-legacy";
		const seeded = upsertPanelTab(EMPTY_PANEL_TAB_STATE, {
			surface: "notes",
			target: "omp-file://localhost/tmp/legacy.html",
			label: "omp-file://localhost/tmp/legacy.html",
		});
		localStorage.setItem(storageKey, JSON.stringify(serializePanelTabs(seeded)));

		const latest = mountPanelProbe(storageKey);

		expect(latest.current?.tabs[0]?.target).toBe("musepi-file://localhost/tmp/legacy.html");
		expect(latest.current?.tabs[0]?.label).toBe("musepi-file://localhost/tmp/legacy.html");
		const stored = localStorage.getItem(storageKey) ?? "";
		expect(stored).not.toMatch(LEGACY_PREFIX);
		expect(JSON.parse(stored).tabs[0].target).toBe("musepi-file://localhost/tmp/legacy.html");
	});
});
