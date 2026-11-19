import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { t } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DeviceCode } from "../src/components/DeviceCode";

const roots: Root[] = [];
let writes: string[] = [];

function stubClipboard(): void {
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				writes.push(text);
			},
		},
	});
}

function mount(node: React.ReactNode): { host: HTMLElement; root: Root } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return { host, root };
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	writes = [];
});

describe("DeviceCode", () => {
	test("copies on arrival, copies again on click, and re-copies a new code", async () => {
		stubClipboard();
		const { host, root } = mount(<DeviceCode code="ABCD-1234" />);
		await act(async () => Bun.sleep(10));

		expect(writes).toEqual(["ABCD-1234"]);
		expect(host.textContent).toContain(t("general.codeCopied"));

		const chip = host.querySelector<HTMLButtonElement>("button.gui-device-code")!;
		act(() => chip.click());
		await act(async () => Bun.sleep(10));
		expect(writes).toEqual(["ABCD-1234", "ABCD-1234"]);

		act(() => root.render(<DeviceCode code="WXYZ-9876" />));
		await act(async () => Bun.sleep(10));
		expect(writes.at(-1)).toBe("WXYZ-9876");
	});

	test("autoCopy=false keeps the code manual-only", async () => {
		stubClipboard();
		const { host } = mount(<DeviceCode code="MANUAL-1" autoCopy={false} />);
		await act(async () => Bun.sleep(10));
		expect(writes).toEqual([]);

		const chip = host.querySelector<HTMLButtonElement>("button.gui-device-code")!;
		act(() => chip.click());
		await act(async () => Bun.sleep(10));
		expect(writes).toEqual(["MANUAL-1"]);
	});
});
