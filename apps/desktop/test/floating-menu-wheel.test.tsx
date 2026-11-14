import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFloatingMenu } from "../src/lib/use-floating-menu";

/**
 * Floating-menu wheel contract.
 *
 * Scrolling while the pointer rests over an open popup used to DISMISS it:
 * the wrapper treated "this menu cannot consume the wheel" as "close and hand
 * the gesture on". Resting the cursor over a short model list and scrolling
 * therefore closed the menu the user was reading.
 *
 * Contract: an open menu never closes on wheel. It consumes the gesture while
 * it has room to scroll; otherwise the gesture scrolls the surface the anchor
 * lives in (the chat transcript as the last resort), and the menu stays open.
 */

const mounted: Root[] = [];

afterEach(() => {
	while (mounted.length > 0) {
		const root = mounted.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

/** A scrollable container that reports a real scroll range and records
 *  programmatic scrolling (happy-dom lays nothing out). */
function scrollableContainer(): { el: HTMLDivElement; scrolled: () => number } {
	const el = document.createElement("div");
	el.style.overflowY = "auto";
	let total = 0;
	Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 800 });
	Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 300 });
	Object.defineProperty(el, "scrollTop", { configurable: true, get: () => total, set: () => {} });
	el.scrollBy = ((opts: ScrollToOptions) => {
		total += opts.top ?? 0;
	}) as typeof el.scrollBy;
	document.body.appendChild(el);
	return { el, scrolled: () => total };
}

function renderMenu(
	anchor: HTMLElement,
	menuBox?: { scrollHeight: number; clientHeight: number; scrollTop: number },
): HTMLDivElement {
	const host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push(root);

	function Harness() {
		const { renderMenu: render } = useFloatingMenu(true, () => {}, {
			className: "harness-menu",
			anchor,
			gap: 8,
		});
		return createElement("div", null, render(createElement("div", null, "item")));
	}

	act(() => root.render(createElement(Harness)));
	const menu = host.querySelector<HTMLDivElement>(".harness-menu");
	if (!menu) throw new Error("the menu did not mount");
	if (menuBox) {
		Object.defineProperty(menu, "scrollHeight", { configurable: true, get: () => menuBox.scrollHeight });
		Object.defineProperty(menu, "clientHeight", { configurable: true, get: () => menuBox.clientHeight });
		Object.defineProperty(menu, "scrollTop", {
			configurable: true,
			get: () => menuBox.scrollTop,
			set: () => {},
		});
	}
	return menu;
}

function wheel(el: HTMLElement, deltaY: number): void {
	act(() => {
		el.dispatchEvent(new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
	});
}

describe("useFloatingMenu wheel", () => {
	test("a popup too short to scroll hands the gesture to the anchor's container and stays open", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const anchor = document.createElement("button");
		scroller.appendChild(anchor);

		const menu = renderMenu(anchor);
		wheel(menu, 120);

		expect(scrolled()).toBe(120);
		expect(menu.isConnected).toBe(true);
		expect(menu.className).not.toContain("gui-menu-popup--closing");
	});

	test("a scrollable popup consumes the wheel itself", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const anchor = document.createElement("button");
		scroller.appendChild(anchor);

		const menu = renderMenu(anchor, { scrollHeight: 600, clientHeight: 200, scrollTop: 100 });
		wheel(menu, 120);

		// Mid-list: the popup owns the gesture, the page beneath must not move.
		expect(scrolled()).toBe(0);
		expect(menu.isConnected).toBe(true);
	});

	test("a scrollable popup at its end chains to the container instead of closing", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const anchor = document.createElement("button");
		scroller.appendChild(anchor);

		const menu = renderMenu(anchor, { scrollHeight: 600, clientHeight: 200, scrollTop: 400 });
		wheel(menu, 120);

		expect(scrolled()).toBe(120);
		expect(menu.isConnected).toBe(true);
		expect(menu.className).not.toContain("gui-menu-popup--closing");
	});
});
