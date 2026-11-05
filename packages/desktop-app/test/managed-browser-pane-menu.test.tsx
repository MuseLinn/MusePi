import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ManagedBrowserPane } from "../src/components/ManagedBrowserPane";
import { closeTab, createTab, getHostState, setBrowserSession } from "../src/lib/managed-browser-host";

const originalElectronAPI = window.electronAPI;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	setBrowserSession(null);
	window.localStorage.removeItem("musepi-gui-managed-browser-history");
	window.localStorage.removeItem("musepi-gui-managed-browser-zoom");
	window.localStorage.removeItem("musepi-gui-browser-device-toolbar");
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		writable: true,
		value: {
			managedBrowserClearData: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserVisibility: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserSetDevice: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserSetZoom: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserActiveTab: vi.fn().mockResolvedValue({ ok: true }),
			copyText: vi.fn().mockResolvedValue(true),
		},
	});
	void createTab("https://example.com/", { tabId: "page" }).catch(() => {});
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root.render(<ManagedBrowserPane open={false} />));
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	for (const tab of getHostState().tabs) closeTab(tab.id, { notifyMain: false });
	setBrowserSession(null);
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
	window.localStorage.removeItem("musepi-gui-managed-browser-history");
	window.localStorage.removeItem("musepi-gui-managed-browser-zoom");
	window.localStorage.removeItem("musepi-gui-browser-device-toolbar");
	vi.restoreAllMocks();
});

function openMenu(): void {
	const trigger = host.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
	act(() => trigger.click());
}

function menuButton(label: string): HTMLButtonElement {
	const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".gui-browser-menu button")).find(
		candidate => candidate.textContent === label,
	);
	expect(button).toBeDefined();
	return button!;
}

describe("managed browser pane menu regressions", () => {
	it("persists device visibility when the menu and toolbar use their shared setter", () => {
		openMenu();
		act(() => menuButton("Hide device toolbar").click());
		expect(window.localStorage.getItem("musepi-gui-browser-device-toolbar")).toBe("hidden");
		expect(host.querySelector(".gui-browser-toolbar")).toBeNull();

		openMenu();
		act(() => menuButton("Show device toolbar").click());
		expect(host.querySelector(".gui-browser-toolbar")).not.toBeNull();
		expect(window.localStorage.getItem("musepi-gui-browser-device-toolbar")).toBeNull();
	});

	it("reports clear-data success through the success toast shape", async () => {
		const details: unknown[] = [];
		const onToast = (event: Event): void => details.push((event as CustomEvent).detail);
		window.addEventListener("musepi-gui-toast", onToast);
		openMenu();
		await act(async () => {
			menuButton("Clear cookies and site data").click();
			await Bun.sleep(0);
		});
		window.removeEventListener("musepi-gui-toast", onToast);
		expect(details).toEqual([{ message: "Browser data cleared", kind: "success" }]);
	});

	it("exposes device visibility and page focus as checked menu items", () => {
		openMenu();
		const device = menuButton("Hide device toolbar");
		const focus = menuButton("Always keep page focused");
		expect(device.getAttribute("role")).toBe("menuitemcheckbox");
		expect(device.getAttribute("aria-checked")).toBe("true");
		expect(focus.getAttribute("role")).toBe("menuitemcheckbox");
		expect(focus.getAttribute("aria-checked")).toBe("false");
	});

	it("uses the native clipboard bridge and surfaces a false result", async () => {
		const copyText = window.electronAPI!.copyText as ReturnType<typeof vi.fn>;
		copyText.mockResolvedValue(false);
		const details: unknown[] = [];
		const onToast = (event: Event): void => details.push((event as CustomEvent).detail);
		window.addEventListener("musepi-gui-toast", onToast);
		openMenu();
		await act(async () => {
			menuButton("Copy URL").click();
			await Bun.sleep(0);
		});
		window.removeEventListener("musepi-gui-toast", onToast);
		expect(copyText).toHaveBeenCalledWith("https://example.com/");
		expect(details).toEqual(["Browser action failed: Copy URL failed"]);
	});

	it("selects the address input after the focus event has been released", async () => {
		const input = host.querySelector<HTMLInputElement>(".gui-browser-address input")!;
		const select = vi.spyOn(input, "select");
		await act(async () => {
			input.focus();
			await Bun.sleep(20);
		});
		expect(select).toHaveBeenCalledTimes(1);
	});
});
