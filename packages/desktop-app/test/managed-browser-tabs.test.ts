import "./happy-dom-shim";
import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	attachElement,
	browserTabsForSession,
	closeTab,
	createTab,
	getHostState,
	type HostWebview,
	renameTab,
	setBrowserSession,
	setTabMuted,
} from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;

afterEach(() => {
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	setBrowserSession(null);
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
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
			writable: true,
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

	test("persists a user title and delegates mute to the guest", () => {
		open("browser-actions");
		const setAudioMuted = vi.fn();
		const element = {
			addEventListener() {},
			removeEventListener() {},
			getWebContentsId: () => 2,
			getURL: () => "about:blank",
			getTitle: () => "Blank",
			canGoBack: () => false,
			canGoForward: () => false,
			isLoading: () => false,
			setAudioMuted,
		} as unknown as HostWebview;
		attachElement("browser-actions", element);
		renameTab("browser-actions", "Research");
		setTabMuted("browser-actions", true);
		const tab = getHostState().tabs.find(candidate => candidate.id === "browser-actions")!;
		expect(tab.customTitle).toBe("Research");
		expect(tab.muted).toBe(true);
		expect(setAudioMuted).toHaveBeenCalledWith(true);
	});

	test("keeps browser tabs and active selection isolated per session", () => {
		setBrowserSession("session-a");
		open("a-tab");
		setBrowserSession("session-b");
		open("b-tab");
		expect(browserTabsForSession("session-a").map(tab => tab.id)).toEqual(["a-tab"]);
		expect(browserTabsForSession("session-b").map(tab => tab.id)).toEqual(["b-tab"]);
		expect(getHostState().activeId).toBe("b-tab");

		setBrowserSession("session-a");
		expect(getHostState().activeId).toBe("a-tab");
		expect(getHostState().tabs.map(tab => tab.id)).toEqual(["a-tab", "b-tab"]);
	});
});
