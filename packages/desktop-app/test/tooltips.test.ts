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

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

function tooltipSize(width: number, height: number): void {
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.id === TIP_ID || this.classList.contains("gui-rail-tooltip") ? width : 40;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.id === TIP_ID || this.classList.contains("gui-rail-tooltip") ? height : 40;
		},
	});
}

function renderRail(): { host: HTMLDivElement; buttons: NodeListOf<HTMLButtonElement> } {
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
	if (buttons.length < 2) throw new Error("rail surfaces did not render");
	return { host, buttons };
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
	act(() => {
		document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch", pointerId: 7 }));
	});
	hideWithEscape();
	for (const child of [...document.body.children]) {
		if (child.id !== TIP_ID) child.remove();
	}
	document.documentElement.classList.remove("gui-motion-off");
	if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
	if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
	vi.restoreAllMocks();
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

	test("a visible tooltip follows an external title update and preserves it on leave", async () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Before update");
		showWithMouse(element);

		await act(async () => {
			element.title = "After update";
			await Promise.resolve();
		});
		expect(tooltip().textContent).toBe("After update");
		expect(tooltip().getAttribute("aria-hidden")).toBe("false");
		pointer(element, "pointerout", { relatedTarget: document.body });
		expect(element.title).toBe("After update");

		showWithMouse(element);
		pointer(element, "pointerout", { relatedTarget: document.body });
		expect(element.title).toBe("After update");
	});

	test("keyboard activation synchronizes the visible tooltip with the activated button title", async () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Maximize panel");
		element.addEventListener("click", () => {
			element.title = "Restore panel";
		});
		act(() => element.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
		advance(150);
		expect(tooltip().textContent).toBe("Maximize panel");

		await act(async () => {
			element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			element.click();
			await Promise.resolve();
		});

		expect(element.title).toBe("Restore panel");
		expect(tooltip().textContent).toBe("Restore panel");
		expect(tooltip().getAttribute("aria-hidden")).toBe("false");
	});

	test("a pending hover tooltip reads the latest title when its delay elapses", async () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Before pending update");
		pointer(element, "pointerover");

		await act(async () => {
			element.title = "After pending update";
			await Promise.resolve();
		});
		advance(149);
		expect(tooltip().getAttribute("aria-hidden")).toBe("true");
		advance(1);

		expect(tooltip().textContent).toBe("After pending update");
		expect(tooltip().getAttribute("aria-hidden")).toBe("false");
		pointer(element, "pointerout", { relatedTarget: document.body });
		expect(element.title).toBe("After pending update");
	});

	test("emptying a title during the touch delay cancels and cleans up the pending tooltip", async () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Touch detail");
		touchStart(element);

		await act(async () => {
			element.title = "";
			await Promise.resolve();
		});
		advance(500);

		expect(tooltip().getAttribute("aria-hidden")).toBe("true");
		expect(element.title).toBe("");
		expect(element.getAttribute("aria-describedby")).toBeNull();
		pointer(element, "pointerup", { pointerType: "touch", pointerId: 7 });
		expect(element.title).toBe("");
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

	test("keyboard focus uses the same opening delay as hover", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Focused detail");

		act(() => element.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
		advance(149);
		expect(document.getElementById(TIP_ID)?.getAttribute("aria-hidden") ?? "true").toBe("true");
		advance(1);

		expect(tooltip().getAttribute("aria-hidden")).toBe("false");
	});

	test("clicking a menu trigger dismisses its tooltip through focus until pointer re-entry", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("New tab");
		showWithMouse(element);
		expect(tooltip().getAttribute("aria-hidden")).toBe("false");

		pointer(element, "pointerdown");
		act(() => element.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
		advance(250);
		expect(tooltip().getAttribute("aria-hidden")).toBe("true");

		pointer(element, "pointerout", { relatedTarget: document.body });
		pointer(element, "pointerover");
		advance(150);
		expect(tooltip().getAttribute("aria-hidden")).toBe("false");
	});

	test("Escape claims the key and dismisses without moving focus", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Dismissible detail");
		showWithMouse(element);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

		act(() => document.dispatchEvent(event));

		expect(event.defaultPrevented).toBe(true);
		expect(tooltip().getAttribute("aria-hidden")).toBe("true");
	});

	test("reduced motion hides immediately without an exit-transition frame", () => {
		vi.useFakeTimers();
		initTooltips();
		document.documentElement.classList.add("gui-motion-off");
		const element = anchor("Static detail");
		showWithMouse(element);

		hideWithEscape();

		expect(tooltip().style.visibility).toBe("hidden");
	});

	test("musepi-ui-dismiss hides a visible tooltip and restores the anchor title", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Dismiss through the page");
		showWithMouse(element);
		expect(tooltip().getAttribute("aria-hidden")).toBe("false");

		act(() => window.dispatchEvent(new Event("musepi-ui-dismiss")));

		expect(tooltip().getAttribute("aria-hidden")).toBe("true");
		expect(element.title).toBe("Dismiss through the page");
	});

	test("scrolling keeps the visible tooltip anchored to its trigger", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Anchored detail");
		showWithMouse(element);
		const previousTop = tooltip().style.top;
		element.getBoundingClientRect = () =>
			({ x: 20, y: 100, left: 20, top: 100, right: 60, bottom: 140, width: 40, height: 40 }) as DOMRect;

		act(() => document.dispatchEvent(new Event("scroll")));

		expect(tooltip().getAttribute("aria-hidden")).toBe("false");
		expect(tooltip().style.top).not.toBe(previousTop);
	});

	test("moving onto the tooltip keeps it visible until the pointer leaves both", () => {
		vi.useFakeTimers();
		initTooltips();
		const element = anchor("Hoverable detail");
		showWithMouse(element);
		const tip = tooltip();

		pointer(element, "pointerout", { relatedTarget: tip });
		expect(tip.getAttribute("aria-hidden")).toBe("false");
		pointer(tip, "pointerout", { relatedTarget: document.body });

		expect(tip.getAttribute("aria-hidden")).toBe("true");
	});

	test("flipping above a bottom-edge anchor does not overlap the trigger", () => {
		vi.useFakeTimers();
		initTooltips();
		viewport(300, 200);
		tooltipSize(100, 40);
		const element = anchor("Bottom edge detail");
		element.getBoundingClientRect = () =>
			({ x: 20, y: 140, left: 20, top: 140, right: 60, bottom: 180, width: 40, height: 40 }) as DOMRect;

		showWithMouse(element);

		expect(tooltip().style.top).toBe("92px");
		expect(tooltip().dataset.placement).toBe("top");
	});
});

describe("RailTooltip accessibility", () => {
	test("keyboard focus exposes the same stable tooltip and restores descriptions on blur", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		const first = buttons[0]!;
		const second = buttons[1]!;
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

	test("Escape claims the key and closes the focused rail tooltip", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		act(() => buttons[0]!.focus());
		advance(150);
		const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });

		act(() => document.dispatchEvent(event));

		expect(event.defaultPrevented).toBe(true);
		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});

	test("moving onto the rail tooltip preserves its anchor and content", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		act(() => buttons[0]!.focus());
		advance(150);
		const tip = host.querySelector<HTMLElement>(".gui-rail-tooltip")!;

		pointer(buttons[0]!, "mouseout", { relatedTarget: tip });
		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(false);
		pointer(tip, "pointerout", { relatedTarget: document.body });

		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});

	test("Escape cancels a rail tooltip before the focus delay completes", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		act(() => buttons[0]!.focus());
		advance(100);

		hideWithEscape();
		advance(100);

		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});

	test("Escape cancels a pending rail touch long-press", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		touchStart(buttons[0]!);
		advance(100);

		hideWithEscape();
		advance(500);

		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});

	test("a tall tooltip shifts into the viewport instead of crossing the top edge", () => {
		vi.useFakeTimers();
		viewport(1000, 200);
		tooltipSize(120, 80);
		const { host, buttons } = renderRail();
		buttons[0]!.getBoundingClientRect = () =>
			({ x: 900, y: 2, left: 900, top: 2, right: 932, bottom: 34, width: 32, height: 32 }) as DOMRect;

		act(() => buttons[0]!.focus());
		advance(150);

		expect(host.querySelector<HTMLElement>(".gui-rail-tooltip")?.style.top).toBe("6px");
	});

	test("a left-edge anchor flips the rail tooltip to the right", () => {
		vi.useFakeTimers();
		viewport(500, 200);
		tooltipSize(120, 80);
		const { host, buttons } = renderRail();
		buttons[0]!.getBoundingClientRect = () =>
			({ x: 4, y: 40, left: 4, top: 40, right: 36, bottom: 72, width: 32, height: 32 }) as DOMRect;

		act(() => buttons[0]!.focus());
		advance(150);
		const tip = host.querySelector<HTMLElement>(".gui-rail-tooltip");

		expect(tip?.dataset.placement).toBe("right");
		expect(tip?.style.left).toBe("44px");
	});

	test("a stationary touch opens the rich rail tooltip and release dismisses it", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();

		touchStart(buttons[0]!);
		advance(499);
		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
		advance(1);
		expect(host.querySelector(".gui-rail-tooltip")).not.toBeNull();
		pointer(buttons[0]!, "pointerup", { pointerType: "touch", pointerId: 7 });

		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});

	test("wheel movement keeps the rich tooltip anchored", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		act(() => buttons[0]!.focus());
		advance(150);
		const previousTop = host.querySelector<HTMLElement>(".gui-rail-tooltip")?.style.top;
		buttons[0]!.getBoundingClientRect = () =>
			({ x: 900, y: 100, left: 900, top: 100, right: 932, bottom: 132, width: 32, height: 32 }) as DOMRect;

		act(() => document.dispatchEvent(new Event("wheel")));

		expect(host.querySelector<HTMLElement>(".gui-rail-tooltip")?.style.top).not.toBe(previousTop);
	});

	test("musepi-ui-dismiss closes the rich tooltip", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		act(() => buttons[0]!.focus());
		advance(150);
		expect(host.querySelector(".gui-rail-tooltip")).not.toBeNull();

		act(() => window.dispatchEvent(new Event("musepi-ui-dismiss")));

		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});

	test("window blur closes the rich tooltip", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		act(() => buttons[0]!.focus());
		advance(150);
		expect(host.querySelector(".gui-rail-tooltip")).not.toBeNull();

		act(() => window.dispatchEvent(new Event("blur")));

		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});

	test("a disconnected anchor closes the rich tooltip during repositioning", () => {
		vi.useFakeTimers();
		const { host, buttons } = renderRail();
		act(() => buttons[0]!.focus());
		advance(150);
		expect(host.querySelector(".gui-rail-tooltip")).not.toBeNull();
		buttons[0]!.remove();

		act(() => document.dispatchEvent(new Event("scroll")));

		expect(host.querySelector(".gui-rail-tooltip") === null).toBe(true);
	});
});
