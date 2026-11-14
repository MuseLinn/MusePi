import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ManagedBrowserPane } from "../src/components/ManagedBrowserPane";
import { closeTab, createTab, getHostState, setPaneRect } from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	setPaneRect(null);
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		writable: true,
		value: {
			managedBrowserVisibility: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserSetDevice: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserSetZoom: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserActiveTab: vi.fn().mockResolvedValue({ ok: true }),
		},
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		x: 10,
		y: 20,
		width: 500,
		height: 400,
		top: 20,
		left: 10,
		right: 510,
		bottom: 420,
		toJSON: () => ({}),
	} as DOMRect);
	void createTab("https://example.com/", { tabId: "page" }).catch(() => {});
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	setPaneRect(null);
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
	vi.restoreAllMocks();
});

describe("managed browser folded visibility", () => {
	it("does not let folded geometry override hidden state and remeasures on reopen", () => {
		act(() => root.render(<ManagedBrowserPane open={false} />));
		expect(getHostState().paneVisible).toBe(false);

		act(() => root.render(<ManagedBrowserPane open={true} />));
		expect(getHostState().paneVisible).toBe(true);
		expect(getHostState().rect?.width).toBe(500);
	});
});
