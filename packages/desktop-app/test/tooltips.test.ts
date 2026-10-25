import "./happy-dom-shim";
import { afterEach, beforeAll, describe, expect, setSystemTime, test, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RightRail } from "../src/components/RightRail";
import { initTooltips } from "../src/lib/tooltips";

const TIP_ID = "musepi-gui-tooltip";
const roots: Root[] = [];

beforeAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
});

function viewport(width: number, height = 768): void {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
	Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

function anchor(title: string, describedBy?: string): HTMLButtonElement {
	const element = document.createElement("button");
	element.title = title;
	element.dataset.tooltipAnchor = "";
	if (describedBy) element.setAttribute("aria-describedby", describedBy);
	element.getBoundingClientRect = () =>
		({
			x: 20,
			y: 20,
			left: 20,
			top: 20,
			right: 60,
			bottom: 60,
			width: 40,
			height: 40,
			toJSON: () => ({}),
		}) as DOMRect;
	document.body.appendChild(element);
	return element;
}

function pointer(element: Element, type: string, options: PointerEventInit = {}): void {
	act(() => {
		element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", ...options }));
	});
}

function advance(ms: number): void {
	act(() => vi.advanceTimersByTime(ms));
}

function showWithMouse(element: Element): void {
	pointer(element, "pointerover");
	advance(250);
}

function hideWithEscape(): void {
	act(() => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
	});
}

function tooltip(): HTMLElement {
	const element = document.getElementById(TIP_ID);
	if (!element) throw new Error("shared tooltip did not render");
	return element;
}

function touchStart(element: Element): void {
	pointer(element, "pointerover", { pointerType: "touch", pointerId: 7, clientX: 20, clientY: 20 });
	pointer(element, "pointerdown", { pointerType: "touch", pointerId: 7, clientX: 20, clientY: 20 });
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	hideWithEscape();
	for (const child of [...document.body.children]) {
		if (child.id !== TIP_ID) child.remove();
	}
	vi.useRealTimers();
	setSystemTime();
	viewport(1024);
});

describe("global tooltips", () => {
	test("showing and hiding preserves the anchor's existing description tokens", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("More detail", "field-help keyboard-help");

		showWithMouse(element);
		expect(element.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(["field-help", "keyboard-help", TIP_ID]);
		pointer(element, "pointerout", { relatedTarget: document.body });

		expect(element.getAttribute("aria-describedby")).toBe("field-help keyboard-help");
		expect(element.title).toBe("More detail");
	});

	test("a narrow-window width cap is removed when the window widens", () => {
		vi.useFakeTimers();
		initTooltips();
		viewport(200);
		const element = anchor("Responsive tooltip");

		showWithMouse(element);
		expect(tooltip().style.maxWidth).toBe("188px");
		hideWithEscape();
		viewport(800);
		showWithMouse(element);

		expect(tooltip().style.maxWidth).toBe("");
	});

	test("a stationary touch holds for the long-press delay", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Touch detail");

		touchStart(element);
		advance(499);
		expect(tooltip().getAttribute("aria-hidden")).toBe("true");
		advance(1);
		expect(tooltip().getAttribute("aria-hidden")).toBe("false");
		pointer(element, "pointerup", { pointerType: "touch", pointerId: 7 });
		expect(tooltip().getAttribute("aria-hidden")).toBe("true");
		expect(element.title).toBe("Touch detail");
	});

	test("moving a touch before the delay cancels the pending tooltip", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Do not show while scrolling");

		touchStart(element);
		advance(100);
		pointer(element, "pointermove", { pointerType: "touch", pointerId: 7, clientX: 50, clientY: 50 });
		advance(600);

		expect(tooltip().getAttribute("aria-hidden")).toBe("true");
		expect(element.title).toBe("Do not show while scrolling");
	});
});

describe("RailTooltip accessibility", () => {
	test("keyboard focus exposes the same stable tooltip and restores descriptions on blur", () => {
		vi.useFakeTimers();
		const host = document.createElement("div");
		host.id = "root";
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push(root);
		act(() =>
			root.render(
				createElement(RightRail, {
					rpc: null,
					rightPanelOpen: true,
					terminalOpen: false,
					onSelect: () => {},
				}),
			),
		);
		const buttons = host.querySelectorAll<HTMLButtonElement>(".gui-right-rail-scroll .gui-right-rail-btn");
		const first = buttons[0];
		const second = buttons[1];
		if (!first || !second) throw new Error("rail surfaces did not render");
		first.setAttribute("aria-describedby", "rail-help");

		act(() => first.focus());
		advance(150);
		const tip = host.querySelector<HTMLElement>(".gui-rail-tooltip");
		expect(tip?.id).not.toBe("");
		const id = tip!.id;
		expect(first.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(["rail-help", id]);

		act(() => second.focus());
		advance(150);
		expect(host.querySelector<HTMLElement>(".gui-rail-tooltip")?.id).toBe(id);
		expect(first.getAttribute("aria-describedby")).toBe("rail-help");
		expect(second.getAttribute("aria-describedby")?.split(/\s+/)).toContain(id);
	});
});
