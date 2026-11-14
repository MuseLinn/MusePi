import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ManagedBrowserExtensions } from "../src/components/managed-browser-extensions";

const originalElectronAPI = window.electronAPI;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
	vi.restoreAllMocks();
});

function apiWith(
	overrides: Partial<NonNullable<typeof window.electronAPI>> = {},
): NonNullable<typeof window.electronAPI> {
	return {
		managedBrowserExtensionsList: vi.fn().mockResolvedValue({ extensions: [], errors: [] }),
		managedBrowserExtensionsChoose: vi.fn().mockResolvedValue({
			candidate: {
				path: "C:\\fixture",
				name: "Fixture extension",
				version: "1.0.0",
				permissions: ["tabs", "storage"],
			},
		}),
		managedBrowserExtensionsInstall: vi.fn().mockResolvedValue({ ok: true }),
		managedBrowserExtensionsRemove: vi.fn().mockResolvedValue({ ok: true }),
		...overrides,
	} as unknown as NonNullable<typeof window.electronAPI>;
}

function render(api: NonNullable<typeof window.electronAPI>): void {
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: api });
	act(() => root.render(<ManagedBrowserExtensions />));
}

function button(name: string): HTMLButtonElement {
	const match = Array.from(host.querySelectorAll("button")).find(candidate => candidate.textContent === name);
	expect(match).toBeDefined();
	return match!;
}

describe("ManagedBrowserExtensions", () => {
	it("shows the real empty state and no external Relay or shared-Chromium content", async () => {
		render(apiWith());
		await act(async () => Bun.sleep(0));
		expect(host.textContent).toContain("No extensions installed in this browser");
		expect(host.textContent).toContain("Install unpacked extension");
		expect(host.textContent).not.toContain("Browser Relay");
		expect(host.textContent).not.toContain("Shared Chromium");
	});

	it("shows startup loading errors without inventing extension rows", async () => {
		render(
			apiWith({
				managedBrowserExtensionsList: vi.fn().mockResolvedValue({ extensions: [], errors: ["load failed"] }),
			}),
		);
		await act(async () => Bun.sleep(0));
		expect(host.textContent).toContain("load failed");
		expect(host.textContent).toContain("No extensions installed in this browser");
	});

	it("loads and removes an actual managed extension", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({
				extensions: [{ id: "fixture-id", name: "Fixture extension", version: "1.0.0", permissions: ["tabs"] }],
				errors: [],
			})
			.mockResolvedValue({ extensions: [], errors: [] });
		const remove = vi.fn().mockResolvedValue({ ok: true });
		render(apiWith({ managedBrowserExtensionsList: list, managedBrowserExtensionsRemove: remove }));
		await act(async () => Bun.sleep(0));
		expect(host.textContent).toContain("Fixture extension");
		expect(host.textContent).toContain("1.0.0");
		await act(async () => {
			button("Uninstall").click();
			await Bun.sleep(0);
		});
		expect(remove).toHaveBeenCalledWith({ id: "fixture-id" });
		expect(list).toHaveBeenCalledTimes(2);
	});

	it("shows permissions before allowing the confirmed install", async () => {
		const choose = vi.fn().mockResolvedValue({
			candidate: {
				path: "C:\\fixture",
				name: "Fixture extension",
				version: "1.0.0",
				permissions: ["tabs", "storage"],
			},
		});
		const install = vi.fn().mockResolvedValue({ ok: true });
		render(apiWith({ managedBrowserExtensionsChoose: choose, managedBrowserExtensionsInstall: install }));
		await act(async () => Bun.sleep(0));
		await act(async () => {
			button("Install unpacked extension").click();
			await Bun.sleep(0);
		});
		expect(host.textContent).toContain("Requested permissions");
		expect(host.textContent).toContain("tabs");
		expect(host.textContent).toContain("storage");
		expect(install).not.toHaveBeenCalled();
		await act(async () => {
			button("Install").click();
			await Bun.sleep(0);
		});
		expect(install).toHaveBeenCalledWith({ confirmed: true });
	});
});
