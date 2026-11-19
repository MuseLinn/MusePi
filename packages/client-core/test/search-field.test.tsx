import { afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { SearchField } = await import("../src/components/common/SearchField");

const roots: Root[] = [];

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

function render(node: React.ReactNode): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return host;
}

describe("shared search field", () => {
	test("renders the control surface, icon and input from the shared contract", () => {
		const host = render(<SearchField value="" onChange={() => {}} placeholder="搜索连接器" className="flex-1" />);
		const wrapper = host.querySelector("label.gui-search")!;
		expect(wrapper.className).toContain("flex-1");
		expect(wrapper.querySelector("svg")).not.toBeNull();
		const input = wrapper.querySelector("input.gui-search-input")!;
		expect(input.getAttribute("type")).toBe("search");
		// aria-label falls back to the placeholder so every field is named.
		expect(input.getAttribute("aria-label")).toBe("搜索连接器");
		expect(input.getAttribute("placeholder")).toBe("搜索连接器");
	});

	test("variant classes cover compact and touch targets", () => {
		const compact = render(<SearchField size="compact" value="" onChange={() => {}} placeholder="a" />);
		expect(compact.querySelector("label.gui-search--compact")).not.toBeNull();

		const touch = render(<SearchField size="touch" value="" onChange={() => {}} placeholder="b" />);
		expect(touch.querySelector("label.gui-search--touch")).not.toBeNull();

		const field = render(<SearchField value="" onChange={() => {}} placeholder="c" />);
		expect(field.querySelector("label.gui-search")!.className).not.toContain("gui-search--");
	});

	test("typing reports the value and the trailing slot stays inside the surface", () => {
		const seen: string[] = [];
		const host = render(
			<SearchField
				value=""
				onChange={value => seen.push(value)}
				placeholder="search"
				size="compact"
				trailing={<button type="button">clear</button>}
			/>,
		);
		const input = host.querySelector("input")!;
		act(() => {
			// React tracks the value property, so the event only fires onChange
			// when the native setter writes it (the testing-library trick).
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setValue.call(input, "connector");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(seen).toEqual(["connector"]);
		expect(host.querySelector("label.gui-search")!.textContent).toContain("clear");
	});

	test("disabled reaches the input, and inputClassName keeps host hooks", () => {
		const host = render(
			<SearchField value="" onChange={() => {}} placeholder="x" disabled inputClassName="mp-search" />,
		);
		const input = host.querySelector("input.mp-search") as HTMLInputElement;
		expect(input.disabled).toBe(true);
		expect(host.querySelector("label.gui-search--disabled")).not.toBeNull();
	});
});
