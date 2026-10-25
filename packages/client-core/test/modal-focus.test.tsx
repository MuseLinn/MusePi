import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = await import("@happy-dom/global-registrator");
dom.GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { isTopModal, useModalFocus } = await import("../src/lib/modal-focus");

afterAll(() => {
	void dom.GlobalRegistrator.unregister();
});

const roots: Root[] = [];

function Modal({
	active = true,
	initialFocus,
	label,
	children,
}: {
	active?: boolean;
	initialFocus?: "first" | "container";
	label: string;
	children?: ReactNode;
}): ReactNode {
	const ref = useModalFocus<HTMLDivElement>(active, { initialFocus });
	return (
		<div ref={ref} aria-label={label}>
			{children}
		</div>
	);
}

function mount(
	label: string,
	options: { active?: boolean; initialFocus?: "first" | "container"; children?: ReactNode } = {},
) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	const render = (active = options.active ?? true) =>
		act(() =>
			root.render(
				<Modal active={active} initialFocus={options.initialFocus} label={label}>
					{options.children}
				</Modal>,
			),
		);
	render();
	const element = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	if (!element) throw new Error(`modal ${label} did not render`);
	return { element, setActive: render };
}

function pressTab(element: HTMLElement, shiftKey = false): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
	element.dispatchEvent(event);
	return event;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("useModalFocus", () => {
	test("focuses the first visible control even when Happy DOM reports zero layout size", () => {
		const { element } = mount("first", {
			children: (
				<>
					<button hidden>hidden</button>
					<button>first</button>
					<button>second</button>
				</>
			),
		});

		expect(document.activeElement).toBe(element.querySelectorAll("button")[1]);
	});

	test("skips controls inside a CSS display:none ancestor", () => {
		mount("CSS hidden ancestor", {
			children: (
				<>
					<div style={{ display: "none" }}>
						<button>hidden</button>
					</div>
					<button>visible</button>
				</>
			),
		});

		expect(document.activeElement?.textContent).toBe("visible");
	});

	test("focuses the container when requested instead of its first control", () => {
		const { element } = mount("container", { initialFocus: "container", children: <button>action</button> });

		expect(document.activeElement).toBe(element);
	});

	test("focuses an empty container and keeps Tab inside it", () => {
		const { element } = mount("empty");

		expect(document.activeElement).toBe(element);
		const event = pressTab(element);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(element);
	});

	test("wraps forward and backward Tab navigation at the focus boundaries", () => {
		const { element } = mount("cycle", {
			children: (
				<>
					<button>first</button>
					<button>last</button>
				</>
			),
		});
		const [first, last] = Array.from(element.querySelectorAll("button"));
		if (!first || !last) throw new Error("cycle controls did not render");

		last.focus();
		pressTab(last);
		expect(document.activeElement).toBe(first);

		pressTab(first, true);
		expect(document.activeElement).toBe(last);
	});

	test("restores the opener when an active modal closes", () => {
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		const { setActive } = mount("restore", { active: false, children: <button>inside</button> });

		setActive(true);
		expect(document.activeElement?.textContent).toBe("inside");
		setActive(false);

		expect(document.activeElement).toBe(opener);
	});

	test("only the top nested modal owns Tab and restores focus down the stack", () => {
		const bottom = mount("bottom", {
			children: (
				<>
					<button>bottom first</button>
					<button>bottom last</button>
				</>
			),
		});
		const top = mount("top", {
			children: (
				<>
					<button>top first</button>
					<button>top last</button>
				</>
			),
		});

		expect(isTopModal(bottom.element)).toBe(false);
		expect(isTopModal(top.element)).toBe(true);

		const [bottomFirst, bottomLast] = Array.from(bottom.element.querySelectorAll("button"));
		const [topFirst, topLast] = Array.from(top.element.querySelectorAll("button"));
		if (!bottomFirst || !bottomLast || !topFirst || !topLast) throw new Error("nested controls did not render");

		bottomLast.focus();
		pressTab(bottomLast);
		expect(document.activeElement?.textContent).toBe("bottom last");

		topLast.focus();
		pressTab(topLast);
		expect(document.activeElement?.textContent).toBe("top first");

		top.setActive(false);
		expect(isTopModal(bottom.element)).toBe(true);
		expect(document.activeElement).toBe(bottomFirst);
	});

	test("skips a disconnected opener when the modal unmounts", () => {
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		mount("detached opener", { children: <button>inside</button> });
		opener.remove();

		const root = roots.pop();
		if (!root) throw new Error("modal root was not registered");
		act(() => root.unmount());

		expect(document.activeElement).not.toBe(opener);
	});

	test("removes the key handler when the modal unmounts", () => {
		const { element } = mount("unmount");
		const root = roots.pop();
		if (!root) throw new Error("modal root was not registered");
		act(() => root.unmount());

		const event = pressTab(element);
		expect(event.defaultPrevented).toBe(false);
	});
});
