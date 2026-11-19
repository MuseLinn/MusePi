import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFloatingMenu } from "../src/lib/use-floating-menu";

/**
 * Floating-menu wheel contract.
 *
 * Scrolling while the pointer rests over an open popup used to DISMISS it:
 * the wrapper treated "this menu cannot consume the wheel" as "close and hand
 * the gesture on". An open menu never closes on wheel — that part stands.
 *
 * Ownership is what the user report changed (浮层滚到顶/尾后背景跟着滚): the
 * popup is portaled into the app root, so the surface behind it is NOT its
 * scroll ancestor — a background scroll can only happen when this code
 * forwards the wheel deliberately. Three cases, all asserted below:
 *
 * 1. a scrollable box under the pointer with room in that direction owns the
 *    gesture — nothing is forwarded;
 * 2. the same box at that edge stops the gesture — the background must not
 *    move (this is the reported bug);
 * 3. a popup where nothing can scroll keeps forwarding to the surface the
 *    anchor lives in (the chat transcript as the last resort), so a short
 *    menu does not trap the wheel.
 */

const mounted: Root[] = [];

afterEach(() => {
	while (mounted.length > 0) {
		const root = mounted.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

/** A scrollable container that records programmatic scrolling (happy-dom lays
 *  nothing out, so the geometry is declared). */
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

interface Box {
	scrollHeight: number;
	clientHeight: number;
	scrollTop: number;
}

/** happy-dom has no layout: give a box the geometry a real scroller would have. */
function sized(el: HTMLElement, box: Box): void {
	Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => box.scrollHeight });
	Object.defineProperty(el, "clientHeight", { configurable: true, get: () => box.clientHeight });
	Object.defineProperty(el, "scrollTop", { configurable: true, get: () => box.scrollTop, set: () => {} });
}

function renderMenu(
	anchor: HTMLElement,
	body: ReactNode = "item",
	menuBox?: Box,
): { menu: HTMLDivElement; list: HTMLElement | null } {
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
		return createElement("div", null, render(createElement("div", null, body)));
	}

	act(() => root.render(createElement(Harness)));
	const menu = host.querySelector<HTMLDivElement>(".harness-menu");
	if (!menu) throw new Error("the menu did not mount");
	if (menuBox) sized(menu, menuBox);
	return { menu, list: host.querySelector<HTMLElement>(".harness-list") };
}

/** The model-selector shape: a scrolling list inside a wrapper that does not scroll. */
function scrollList(): ReactNode {
	// Inline overflow stands in for the sheet's `overflow-y: auto`; happy-dom
	// runs no stylesheet, and the hook reads the computed value.
	return createElement("div", { className: "harness-list", style: { overflowY: "auto" } }, "item");
}

/** The same list under non-scrolling chrome — a search field and an action row,
 *  which is where the pointer often rests when the user starts to scroll. */
function chromeWithList(): ReactNode {
	return [
		createElement("div", { className: "harness-header", key: "header" }, "search"),
		createElement("div", { className: "harness-list", key: "list", style: { overflowY: "auto" } }, "item"),
	];
}

function wheel(el: HTMLElement, deltaY: number): void {
	act(() => {
		el.dispatchEvent(new window.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true }));
	});
}

function anchorIn(scroller: HTMLElement): HTMLButtonElement {
	const anchor = document.createElement("button");
	scroller.appendChild(anchor);
	return anchor;
}

function expectStillOpen(menu: HTMLElement): void {
	expect(menu.isConnected).toBe(true);
	expect(menu.className).not.toContain("gui-menu-popup--closing");
}

describe("useFloatingMenu wheel", () => {
	test("case 3: a popup too short to scroll hands the gesture to the anchor's container and stays open", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu } = renderMenu(anchorIn(scroller));

		wheel(menu, 120);

		expect(scrolled()).toBe(120);
		expectStillOpen(menu);
	});

	test("case 1: a scrollable popup mid-list owns the gesture", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu } = renderMenu(anchorIn(scroller), "item", {
			scrollHeight: 600,
			clientHeight: 200,
			scrollTop: 100,
		});

		wheel(menu, 120);

		expect(scrolled(), "the popup still had room: the page beneath must not move").toBe(0);
		expectStillOpen(menu);
	});

	test("case 1b: a scrolling list inside a non-scrolling wrapper owns the gesture", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu, list } = renderMenu(anchorIn(scroller), scrollList());
		// The wrapper is too short to scroll; the list inside it is the scroller.
		sized(list!, { scrollHeight: 640, clientHeight: 300, scrollTop: 100 });

		wheel(list!, 120);

		expect(scrolled(), "the list had room: the transcript must not move").toBe(0);
		expectStillOpen(menu);
	});

	test("case 1c: a wheel over the popup's non-scrolling chrome turns its inner list", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu, list } = renderMenu(anchorIn(scroller), chromeWithList());
		sized(list!, { scrollHeight: 640, clientHeight: 300, scrollTop: 100 });
		const own: number[] = [];
		list!.scrollBy = ((options: ScrollToOptions) => own.push(options.top ?? 0)) as typeof list.scrollBy;
		const header = menu.querySelector<HTMLElement>(".harness-header")!;

		// The pointer rests on the search field, above the list: the wheel must
		// drive the list the popup frames, not the transcript behind the portal.
		wheel(header, 120);

		expect(scrolled(), "reported bug: chrome over a list still scrolled the background").toBe(0);
		expect(own, "the popup's own list must take the wheel").toEqual([120]);

		// Second tick: the resolved owner is cached per placement, so it must
		// keep driving the same list instead of re-walking the subtree.
		wheel(header, 120);
		expect(own, "the cached owner must serve the next tick").toEqual([120, 120]);
		expect(scrolled()).toBe(0);
		expectStillOpen(menu);
	});

	test("case 3b: chrome with nothing scrollable inside still forwards to the page", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu } = renderMenu(anchorIn(scroller), createElement("div", { className: "harness-header" }, "search"));

		wheel(menu.querySelector<HTMLElement>(".harness-header")!, 120);

		expect(scrolled(), "a menu with nothing to scroll must not trap the wheel").toBe(120);
		expectStillOpen(menu);
	});

	test("case 1d: a cached owner that stops overflowing is resolved again", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu, list } = renderMenu(anchorIn(scroller), chromeWithList());
		const box = { scrollHeight: 640, clientHeight: 300, scrollTop: 100 };
		sized(list!, box);
		const own: number[] = [];
		list!.scrollBy = ((options: ScrollToOptions) => own.push(options.top ?? 0)) as typeof list.scrollBy;
		const header = menu.querySelector<HTMLElement>(".harness-header")!;

		wheel(header, 120);
		// The filtered list no longer overflows; the cached owner must be
		// re-validated instead of swallowing the next tick.
		box.scrollHeight = 300;
		wheel(header, 120);

		expect(own, "only the first tick belonged to the list").toEqual([120]);
		expect(scrolled(), "with nothing scrollable left, the page takes the wheel").toBe(120);
		expectStillOpen(menu);
	});

	test("case 2: a scrollable popup at its end stops instead of chaining to the page", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu } = renderMenu(anchorIn(scroller), "item", {
			scrollHeight: 600,
			clientHeight: 200,
			scrollTop: 400,
		});

		wheel(menu, 120);

		expect(scrolled(), "reported bug: the transcript scrolled behind the open menu").toBe(0);
		expectStillOpen(menu);
	});

	test("case 2b: a scrolling list at its end stops a downward wheel", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu, list } = renderMenu(anchorIn(scroller), scrollList());
		sized(list!, { scrollHeight: 640, clientHeight: 300, scrollTop: 340 });

		wheel(list!, 120);

		expect(scrolled(), "the list was at its end: the transcript must not move").toBe(0);
		expectStillOpen(menu);
	});

	test("case 2c: a scrolling list at its top stops an upward wheel", () => {
		const { el: scroller, scrolled } = scrollableContainer();
		const { menu, list } = renderMenu(anchorIn(scroller), scrollList());
		sized(list!, { scrollHeight: 640, clientHeight: 300, scrollTop: 0 });

		wheel(list!, -120);

		expect(scrolled(), "the list was at its top: the transcript must not move").toBe(0);
		expectStillOpen(menu);
	});
});
