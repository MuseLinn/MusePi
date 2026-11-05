import "./happy-dom-shim";
import { afterEach, describe, expect, test, vi } from "bun:test";
import type { HostWebview } from "../src/lib/managed-browser-host";
import * as browserHost from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;

afterEach(() => {
	for (const tab of browserHost.getHostState().tabs) browserHost.closeTab(tab.id, { notifyMain: false });
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
	vi.restoreAllMocks();
});

function attachPage(tabId: string, overrides: Partial<HostWebview> = {}): HostWebview {
	void browserHost.createTab("https://example.com/", { tabId }).catch(() => {});
	const element = {
		addEventListener() {},
		removeEventListener() {},
		getWebContentsId: () => 42,
		getURL: () => "https://example.com/",
		getTitle: () => "Example",
		canGoBack: () => false,
		canGoForward: () => false,
		isLoading: () => false,
		...overrides,
	} as unknown as HostWebview;
	browserHost.attachElement(tabId, element);
	return element;
}

describe("managed browser menu actions", () => {
	test("find and clear-selection target the active page", () => {
		const findInPage = vi.fn();
		const stopFindInPage = vi.fn();
		attachPage("find-page", { findInPage, stopFindInPage });

		browserHost.findInActivePage("needle");
		browserHost.stopFindInActivePage();

		expect(findInPage).toHaveBeenCalledWith("needle");
		expect(stopFindInPage).toHaveBeenCalledWith("clearSelection");
	});

	test("print routes the active managed id and surfaces native failures", async () => {
		attachPage("print-page");
		const managedBrowserPrint = vi.fn().mockResolvedValue({ ok: false, error: "print denied" });
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			writable: true,
			value: { managedBrowserPrint },
		});

		await expect(browserHost.printActivePage()).rejects.toThrow("print denied");
		expect(managedBrowserPrint).toHaveBeenCalledWith({ tabId: "print-page" });
	});

	test("screenshot uses the active webContents id and rejects an unavailable capture", async () => {
		attachPage("shot-page");
		const managedBrowserCapturePage = vi.fn().mockResolvedValue(null);
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			writable: true,
			value: { managedBrowserCapturePage },
		});

		await expect(browserHost.captureActivePage()).rejects.toThrow(/screenshot/i);
		expect(managedBrowserCapturePage).toHaveBeenCalledWith({ webContentsId: 42 });
	});

	test("save-screenshot routes the active id and distinguishes cancel from failure", async () => {
		attachPage("save-shot-page");
		const managedBrowserSaveScreenshot = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, canceled: true })
			.mockResolvedValueOnce({ ok: false, error: "disk full" });
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			writable: true,
			value: { managedBrowserSaveScreenshot },
		});

		await expect(browserHost.saveActivePageScreenshot()).resolves.toEqual({ ok: false, canceled: true });
		await expect(browserHost.saveActivePageScreenshot()).rejects.toThrow("disk full");
		expect(managedBrowserSaveScreenshot).toHaveBeenNthCalledWith(1, { tabId: "save-shot-page" });
		expect(managedBrowserSaveScreenshot).toHaveBeenNthCalledWith(2, { tabId: "save-shot-page" });
	});

	test("downloads reports an OS open-folder failure", async () => {
		const managedBrowserShowDownloads = vi.fn().mockResolvedValue({ ok: false, error: "missing folder" });
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			writable: true,
			value: { managedBrowserShowDownloads },
		});

		await expect(browserHost.showDownloads()).rejects.toThrow("missing folder");
		expect(managedBrowserShowDownloads).toHaveBeenCalledWith();
	});

	test("clear-data preserves its mode and rejects failed native cleanup", async () => {
		const managedBrowserClearData = vi.fn().mockResolvedValue({ ok: false, error: "cleanup denied" });
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			writable: true,
			value: { managedBrowserClearData },
		});

		await expect(browserHost.clearData("cookies")).rejects.toThrow("cleanup denied");
		expect(managedBrowserClearData).toHaveBeenCalledWith("cookies");
	});
});
