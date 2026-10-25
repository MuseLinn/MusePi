import "./happy-dom-shim";
import { afterEach, describe, expect, test, vi } from "bun:test";
import { attachElement, closeTab, createTab, getHostState, type HostWebview } from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;

afterEach(() => {
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	Object.defineProperty(window, "electronAPI", { configurable: true, value: originalElectronAPI });
	vi.restoreAllMocks();
});

function open(id: string): void {
	void createTab("about:blank", { tabId: id }).catch(() => {});
}

describe("managed browser tab state", () => {
	test("closing immediately removes the tab and activates the remaining neighbour", () => {
		open("browser-a");
		open("browser-b");
		expect(getHostState().activeId).toBe("browser-b");
		closeTab("browser-b", { notifyMain: false });
		expect(getHostState().tabs.map(tab => tab.id)).toEqual(["browser-a"]);
		expect(getHostState().activeId).toBe("browser-a");
	});

	test("the last tab closes in state before ref detach reports guest-gone", async () => {
		const gone = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			value: { managedBrowserGuestGone: gone, managedBrowserGuestReady: vi.fn().mockResolvedValue(undefined) },
		});
		open("browser-last");
		const element = {
			addEventListener() {},
			removeEventListener() {},
			getWebContentsId: () => 1,
			getURL: () => "about:blank",
			getTitle: () => "Blank",
			canGoBack: () => false,
			canGoForward: () => false,
			isLoading: () => false,
		} as unknown as HostWebview;
		attachElement("browser-last", element);
		closeTab("browser-last", { notifyMain: false });
		expect(getHostState().tabs).toEqual([]);
		expect(gone).not.toHaveBeenCalled();
		attachElement("browser-last", null);
		await Bun.sleep(0);
		expect(gone).toHaveBeenCalledWith("browser-last");
	});
});
