import "./happy-dom-shim";
import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	attachElement,
	browserPageContextDetail,
	closeTab,
	createTab,
	getHostState,
	type HostRect,
	type HostWebview,
	setPaneRect,
} from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;

afterEach(() => {
	setPaneRect(null);
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
	vi.restoreAllMocks();
});

describe("browser page context coordinates", () => {
	test("scales guest coordinates into the pane viewport", () => {
		const rect: HostRect = { x: 100, y: 50, width: 800, height: 600, scale: 0.5 };

		expect(browserPageContextDetail("tab", { x: 200, y: 100 }, rect)).toEqual({
			tabId: "tab",
			x: 200,
			y: 100,
			linkURL: "",
			selectionText: "",
			isEditable: false,
			elementX: 200,
			elementY: 100,
		});
	});

	test("subtracts the scrollport clip before applying the scale", () => {
		const rect: HostRect = {
			x: 10,
			y: 20,
			width: 400,
			height: 300,
			scale: 2,
			clip: { top: 30, right: 0, bottom: 0, left: 40 },
		};

		const detail = browserPageContextDetail("tab", { x: 100, y: 80 }, rect);

		expect(detail.x).toBe(130);
		expect(detail.y).toBe(120);
		expect(detail.elementX).toBe(100);
		expect(detail.elementY).toBe(80);
	});

	test("falls back to unscaled page coordinates without a host rect", () => {
		const detail = browserPageContextDetail(
			"tab",
			{
				x: 12,
				y: 34,
				linkURL: "https://example.test/link",
				selectionText: "selected text",
				isEditable: true,
			},
			null,
		);

		expect(detail).toEqual({
			tabId: "tab",
			x: 12,
			y: 34,
			linkURL: "https://example.test/link",
			selectionText: "selected text",
			isEditable: true,
			elementX: 12,
			elementY: 34,
		});
	});

	test("only a literal true marks the page field editable", () => {
		const editable = (value: unknown): boolean =>
			browserPageContextDetail("tab", { x: 0, y: 0, isEditable: value as boolean }, null).isEditable;

		expect(editable(true)).toBe(true);
		expect(editable(1)).toBe(false);
		expect(editable("true")).toBe(false);
		expect(editable(undefined)).toBe(false);
	});
});

describe("managed browser host context-menu wiring", () => {
	test("dispatches the mapped detail for the guest that reported the menu", () => {
		const guestReady = vi.fn().mockResolvedValue(undefined);
		const guestGone = vi.fn().mockResolvedValue(undefined);
		const visibility = vi.fn().mockResolvedValue({ ok: true });
		const activeTab = vi.fn().mockResolvedValue({ ok: true });
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			writable: true,
			value: {
				managedBrowserGuestReady: guestReady,
				managedBrowserGuestGone: guestGone,
				managedBrowserVisibility: visibility,
				managedBrowserActiveTab: activeTab,
			},
		});
		const listeners = new Map<string, (event: Event) => void>();
		const element = {
			addEventListener: (type: string, listener: (event: Event) => void) => listeners.set(type, listener),
			removeEventListener: (type: string) => listeners.delete(type),
			getWebContentsId: () => 5,
			getURL: () => "https://example.test/",
			getTitle: () => "Example",
			canGoBack: () => false,
			canGoForward: () => false,
			isLoading: () => false,
		} as unknown as HostWebview;

		void createTab("https://example.test/", { tabId: "ctx" }).catch(() => {});
		setPaneRect({
			x: 100,
			y: 50,
			width: 800,
			height: 600,
			scale: 0.5,
			clip: { top: 10, right: 0, bottom: 0, left: 20 },
		});
		attachElement("ctx", element);

		const details: unknown[] = [];
		const onMenu = (event: Event): void => details.push((event as CustomEvent).detail);
		window.addEventListener("musepi-browser-page-context-menu", onMenu);
		const preventDefault = vi.fn();
		listeners.get("context-menu")?.({
			preventDefault,
			params: { x: 100, y: 60, linkURL: "https://example.test/link", selectionText: "text", isEditable: true },
		} as unknown as Event);
		window.removeEventListener("musepi-browser-page-context-menu", onMenu);

		expect(preventDefault).toHaveBeenCalledTimes(1);
		expect(details).toEqual([
			{
				tabId: "ctx",
				x: 140,
				y: 75,
				linkURL: "https://example.test/link",
				selectionText: "text",
				isEditable: true,
				elementX: 100,
				elementY: 60,
			},
		]);

		attachElement("ctx", null);
		closeTab("ctx", { notifyMain: false });
	});
});
