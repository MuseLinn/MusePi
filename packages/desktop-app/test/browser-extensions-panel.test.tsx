import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserExtensionsPanel } from "../src/components/browser-extensions-panel";
import { BrowserSection } from "../src/components/settings-sections/browser";
import type { RpcClient } from "../src/lib/rpc";

let host: HTMLDivElement;
let root: Root;

function rpcWith(request: (method: string, params: unknown) => unknown): RpcClient {
	return {
		request: vi.fn((method: string, params: unknown) => Promise.resolve(request(method, params))),
	} as unknown as RpcClient;
}

function relayStatus(overrides: Partial<{ installed: boolean; serving: boolean; connected: boolean }> = {}) {
	return {
		installed: false,
		serving: false,
		connected: false,
		extensionDir: "C:\\MusePi\\relay",
		...overrides,
	};
}

beforeEach(() => {
	window.localStorage.removeItem("musepi-gui-browser-settings-tab");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	window.localStorage.removeItem("musepi-gui-browser-settings-tab");
	vi.restoreAllMocks();
});

function button(name: string): HTMLButtonElement {
	const match = Array.from(host.querySelectorAll("button")).find(candidate => candidate.textContent === name);
	expect(match).toBeDefined();
	return match!;
}

describe("BrowserExtensionsPanel", () => {
	it("shows real-Chrome Relay status and extensions from the shared Chromium", async () => {
		const rpc = rpcWith(method => {
			if (method === "browser.relayStatus") return relayStatus({ installed: true, serving: true, connected: true });
			if (method === "browser.extensions") {
				return {
					extensions: [{ id: "ext-1", name: "Example extension", version: "1.2.3" }],
					profileDir: "C:\\MusePi\\profile",
				};
			}
			throw new Error(`Unexpected RPC ${method}`);
		});
		await act(async () => {
			root.render(<BrowserExtensionsPanel rpc={rpc} />);
			await Bun.sleep(0);
		});
		expect(host.textContent).toContain("Shared Chromium");
		expect(host.textContent).toContain("Connected — MusePi can drive your Chrome tabs");
		expect(host.textContent).toContain("Example extension");
		expect(host.textContent).toContain("1.2.3");
	});

	it("installs the Relay and refreshes its live status", async () => {
		let connected = false;
		const rpc = rpcWith(method => {
			if (method === "browser.relayInstall") {
				connected = true;
				return { dir: "C:\\MusePi\\relay", ok: true };
			}
			if (method === "browser.relayStatus") {
				return relayStatus({ installed: connected, serving: connected, connected });
			}
			if (method === "browser.extensions") return { extensions: [], profileDir: "C:\\MusePi\\profile" };
			throw new Error(`Unexpected RPC ${method}`);
		});
		await act(async () => {
			root.render(<BrowserExtensionsPanel rpc={rpc} />);
			await Bun.sleep(0);
		});
		await act(async () => {
			button("Install").click();
			await Bun.sleep(0);
		});
		expect(rpc.request).toHaveBeenCalledWith("browser.relayInstall", {});
		expect(host.textContent).toContain("Connected — MusePi can drive your Chrome tabs");
	});

	it("surfaces a Relay action failure", async () => {
		const rpc = rpcWith(method => {
			if (method === "browser.relayStatus") return relayStatus({ installed: true });
			if (method === "browser.extensions") return { extensions: [], profileDir: "C:\\MusePi\\profile" };
			if (method === "browser.relayUninstall") return Promise.reject(new Error("remove denied"));
			throw new Error(`Unexpected RPC ${method}`);
		});
		await act(async () => {
			root.render(<BrowserExtensionsPanel rpc={rpc} />);
			await Bun.sleep(0);
		});
		await act(async () => {
			button("Uninstall").click();
			await Bun.sleep(0);
		});
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("remove denied");
	});

	it("moves from extension loading to the real empty state", async () => {
		const pending = Promise.withResolvers<{ extensions: []; profileDir: string }>();
		const rpc = rpcWith(method => {
			if (method === "browser.relayStatus") return relayStatus();
			if (method === "browser.extensions") return pending.promise;
			throw new Error(`Unexpected RPC ${method}`);
		});
		act(() => root.render(<BrowserExtensionsPanel rpc={rpc} />));
		expect(host.textContent).toContain("Loading extensions…");
		await act(async () => {
			pending.resolve({ extensions: [], profileDir: "C:\\MusePi\\profile" });
			await pending.promise;
		});
		expect(host.textContent).toContain("No extensions installed");
	});
});

describe("Browser settings views", () => {
	it("switches between general, extensions, and data without losing the existing controls", async () => {
		const rpc = rpcWith(method => {
			if (method === "settings.get") return {};
			if (method === "browser.endpoint") return {};
			if (method === "browser.tabs") return { tabs: [] };
			if (method === "browser.relayStatus") return relayStatus({ installed: true, serving: true, connected: true });
			if (method === "browser.extensions") return { extensions: [], profileDir: "C:\\MusePi\\profile" };
			throw new Error(`Unexpected RPC ${method}`);
		});
		await act(async () => {
			root.render(<BrowserSection rpc={rpc} />);
			await Bun.sleep(0);
		});
		expect(host.textContent).toContain("Browser engine");
		act(() => button("Extensions").click());
		expect(host.textContent).toContain("MusePi Browser Relay extension");
		expect(host.textContent).toContain("Shared Chromium");
		expect(window.localStorage.getItem("musepi-gui-browser-settings-tab")).toBe("extensions");
		act(() => button("Browser data").click());
		expect(host.textContent).toContain("Import Chrome data");
		expect(host.textContent).toContain("Clear built-in browser cache");
		act(() => button("General").click());
		expect(host.textContent).toContain("Browser engine");
	});
});
