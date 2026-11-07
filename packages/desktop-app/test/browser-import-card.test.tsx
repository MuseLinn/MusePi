import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserImportCard } from "../src/components/browser-import-card";
import type { RpcClient } from "../src/lib/rpc";

let host: HTMLDivElement;
let root: Root;

function rpcWith(request: (method: string, params: unknown) => unknown): RpcClient {
	return { request: vi.fn(request) } as unknown as RpcClient;
}

beforeEach(() => {
	window.localStorage.removeItem("musepi-gui-browser-import-dismissed");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	window.localStorage.removeItem("musepi-gui-browser-import-dismissed");
	vi.restoreAllMocks();
});

function button(name: string): HTMLButtonElement {
	const match = Array.from(host.querySelectorAll("button")).find(candidate => candidate.textContent === name);
	expect(match).toBeDefined();
	return match!;
}

describe("BrowserImportCard", () => {
	it("imports cookies and localStorage into the shared automation Chromium with visible progress", async () => {
		const pending = Promise.withResolvers<{ ok: boolean; importedFrom: string }>();
		const rpc = rpcWith(() => pending.promise);
		act(() => root.render(<BrowserImportCard rpc={rpc} />));
		expect(host.textContent).toContain("cookies and localStorage");
		expect(host.textContent).toContain("shared automation Chromium");
		expect(host.textContent).not.toContain("C:\\Chrome");

		act(() => button("Import").click());
		expect(button("Importing…").disabled).toBe(true);
		await act(async () => {
			pending.resolve({ ok: true, importedFrom: "C:\\Chrome\\Default" });
			await pending.promise;
		});
		expect(rpc.request).toHaveBeenCalledWith("browser.importChrome", {});
		expect(host.textContent).toContain("Chrome data imported into the shared automation Chromium");
		expect(host.textContent).not.toContain("C:\\Chrome\\Default");
	});

	it("keeps a reported import failure inline", async () => {
		const rpc = rpcWith(() => ({ ok: false, error: "Chrome is busy" }));
		act(() => root.render(<BrowserImportCard rpc={rpc} />));
		await act(async () => {
			button("Import").click();
			await Bun.sleep(0);
		});
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("Chrome is busy");
	});

	it("keeps a rejected import inline instead of spinning forever", async () => {
		const rpc = rpcWith(() => Promise.reject(new Error("Profile locked")));
		act(() => root.render(<BrowserImportCard rpc={rpc} />));
		await act(async () => {
			button("Import").click();
			await Bun.sleep(0);
		});
		expect(host.querySelector('[role="alert"]')?.textContent).toBe("Profile locked");
	});

	it("remembers dismissal and offers the data-settings route", async () => {
		const onOpenData = vi.fn();
		const rpc = rpcWith(() => ({ ok: true }));
		act(() => root.render(<BrowserImportCard rpc={rpc} dismissible onOpenData={onOpenData} />));
		act(() => host.querySelector<HTMLButtonElement>('[aria-label="Browser data settings"]')!.click());
		expect(onOpenData).toHaveBeenCalledTimes(1);
		act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss Chrome import"]')!.click());
		expect(window.localStorage.getItem("musepi-gui-browser-import-dismissed")).toBe("1");
		expect(host.textContent).not.toContain("Import Chrome data");

		act(() => root.unmount());
		root = createRoot(host);
		act(() => root.render(<BrowserImportCard rpc={rpc} dismissible onOpenData={onOpenData} />));
		expect(host.textContent).not.toContain("Import Chrome data");
	});
});
