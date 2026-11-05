import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextMenu } from "../src/components/ContextMenu";
import { ManagedBrowserHost } from "../src/components/ManagedBrowserHost";

const originalElectronAPI = window.electronAPI;
let host: HTMLDivElement;
let root: Root;

function Harness(): ReactNode {
	const [open, setOpen] = useState(true);
	return (
		<>
			<ManagedBrowserHost />
			<ContextMenu open={open} x={20} y={20} items={[]} onClose={() => setOpen(false)} />
		</>
	);
}

beforeEach(() => {
	window.localStorage.removeItem("musepi-gui-managed-browser-tabs");
	Object.defineProperty(window, "electronAPI", {
		configurable: true,
		writable: true,
		value: {
			onManagedBrowserState: () => () => {},
			onManagedBrowserConfirm: () => () => {},
			onManagedBrowserUploadRequest: () => () => {},
			onManagedBrowserUploadDismiss: () => () => {},
			onManagedBrowserCreateTab: () => () => {},
			onManagedBrowserSelectTab: () => () => {},
			onManagedBrowserCloseTab: () => () => {},
			managedBrowserGetState: vi.fn().mockResolvedValue({ port: null, activity: null, busyTabIds: [] }),
			managedBrowserHostReady: vi.fn().mockResolvedValue({ ok: true }),
			managedBrowserGuestGone: vi.fn().mockResolvedValue(undefined),
		},
	});
	host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root.render(<Harness />));
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	window.localStorage.removeItem("musepi-gui-managed-browser-tabs");
	Object.defineProperty(window, "electronAPI", { configurable: true, writable: true, value: originalElectronAPI });
	vi.restoreAllMocks();
});

function dismissHotzone(): HTMLElement {
	const zone = host.querySelector<HTMLElement>(".gui-managed-host-dismiss");
	if (!zone) throw new Error("managed host did not render its dismiss hotzone");
	return zone;
}

describe("managed browser dismiss hotzone", () => {
	it("covers the page while a floating menu is open and dispatches musepi-ui-dismiss", () => {
		const zone = dismissHotzone();
		const details: unknown[] = [];
		const onDismiss = (event: Event): void => details.push((event as CustomEvent).detail);
		window.addEventListener("musepi-ui-dismiss", onDismiss);

		act(() => zone.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));

		window.removeEventListener("musepi-ui-dismiss", onDismiss);
		expect(details).toEqual([{ source: "managed-browser" }]);
	});

	it("closes the page menu through the same outside click", () => {
		const zone = dismissHotzone();

		act(() => {
			zone.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
			zone.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		});

		expect(host.querySelector(".gui-managed-host-dismiss")).toBeNull();
	});
});
