import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFloatingMenu } from "../src/lib/use-floating-menu";

/**
 * `useFloatingMenu` flyout side — the second half of the right-rail overflow
 * fix (2026-10-18).
 *
 * Portalling alone was not enough. The rail is flush against the window's
 * right edge, so a popup anchored to a rail button and opened DOWNWARD gets
 * shifted back into the viewport by the horizontal clamp and collapses to a
 * sliver against that edge. `side: "left"` pins the popup's RIGHT edge to the
 * anchor's LEFT edge instead, so it grows into the space the rail cannot use.
 *
 * Contracts asserted on the portalled wrapper's inline style:
 * - with `side: "left"` the popup's right edge stays left of the anchor's left
 *   edge (it flew out, not under the trigger) and inside the viewport;
 * - tall content is clamped to the viewport and scrolls internally;
 * - `side: "bottom"` (the default) is unchanged — existing menus must not move.
 */

const mounted: Root[] = [];

// happy-dom lays nothing out (every offset* is 0), so the primitive would fall
// back to its 260×300 open-time estimate. Give the popup a real measured box at
// the prototype level so placement arithmetic uses it on the FIRST pass too.
const MENU_W = 168;
const MENU_H = 120;
const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

function stubMenuSize(): void {
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("harness-menu") ? MENU_W : (widthDescriptor?.get?.call(this) ?? 0);
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.classList.contains("harness-menu") ? MENU_H : (heightDescriptor?.get?.call(this) ?? 0);
		},
	});
}

function restoreMenuSize(): void {
	if (widthDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor);
	if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDescriptor);
}

afterEach(() => {
	while (mounted.length > 0) {
		const root = mounted.pop();
		if (root) act(() => root.unmount());
	}
	restoreMenuSize();
	document.body.innerHTML = "";
});

const VIEWPORT_W = window.innerWidth;
const VIEWPORT_H = window.innerHeight;
const EDGE_PAD = 8;
const GAP = 8;

/** A detached anchor whose viewport rect is what the contract is about. */
function stubAnchor(rect: { left: number; top: number; right: number; bottom: number }): HTMLElement {
	const el = document.createElement("button");
	const box = {
		...rect,
		width: rect.right - rect.left,
		height: rect.bottom - rect.top,
		x: rect.left,
		y: rect.top,
		toJSON: () => ({}),
	};
	el.getBoundingClientRect = () => box as DOMRect;
	document.body.appendChild(el);
	return el;
}

/** Renders an open menu for `anchor` using `side`; returns the portalled wrapper. */
function renderMenu(side: "bottom" | "left", anchor: HTMLElement): HTMLDivElement {
	const host = document.createElement("div");
	host.id = "root";
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push(root);

	function Harness() {
		const { renderMenu: render } = useFloatingMenu(true, () => {}, {
			className: "harness-menu",
			side,
			anchor,
			gap: GAP,
		});
		return createElement("div", null, render(createElement("div", null, "item")));
	}

	stubMenuSize();
	act(() => root.render(createElement(Harness)));

	const menu = host.querySelector<HTMLDivElement>(".harness-menu");
	if (!menu) throw new Error("the menu did not mount");
	return menu;
}

const num = (v: string): number => Number.parseFloat(v);

describe("useFloatingMenu flyout side", () => {
	test("side=left grows away from a right-edge anchor instead of under it", () => {
		// A rail button hugging the window's right edge.
		const anchorLeft = VIEWPORT_W - 60;
		const anchor = stubAnchor({ left: anchorLeft, top: 300, right: VIEWPORT_W - 28, bottom: 332 });
		const menu = renderMenu("left", anchor);

		const left = num(menu.style.left);
		expect(Number.isFinite(left)).toBe(true);
		// The popup's right edge sits left of the anchor's left edge — it flew
		// OUT into the workspace, not under the rail.
		expect(left + MENU_W).toBeLessThanOrEqual(anchorLeft);
		// Fully inside the viewport on both axes.
		expect(left).toBeGreaterThanOrEqual(EDGE_PAD);
		expect(left + MENU_W).toBeLessThanOrEqual(VIEWPORT_W - EDGE_PAD);
		expect(num(menu.style.top)).toBeGreaterThanOrEqual(EDGE_PAD);
	});

	test("side=left clamps a tall menu into the viewport and scrolls it", () => {
		const anchor = stubAnchor({
			left: VIEWPORT_W - 60,
			top: VIEWPORT_H - 40,
			right: VIEWPORT_W - 28,
			bottom: VIEWPORT_H - 8,
		});
		const menu = renderMenu("left", anchor);

		const maxHeight = num(menu.style.maxHeight);
		expect(maxHeight).toBeGreaterThan(0);
		// Room is reserved at both window edges rather than running off-window.
		expect(maxHeight).toBeLessThanOrEqual(VIEWPORT_H - EDGE_PAD * 2);
		expect(menu.style.overflowY).toBe("auto");

		const top = num(menu.style.top);
		expect(top).toBeGreaterThanOrEqual(EDGE_PAD);
		expect(top + Math.min(MENU_H, maxHeight)).toBeLessThanOrEqual(VIEWPORT_H - EDGE_PAD + 0.5);
	});

	test("side=bottom (the default shape) still drops below the anchor", () => {
		const anchor = stubAnchor({ left: 400, top: 200, right: 460, bottom: 232 });
		const menu = renderMenu("bottom", anchor);

		// Existing call sites must not move: the popup hangs BELOW the anchor and
		// shares its left edge (align defaults to left).
		expect(num(menu.style.top)).toBeGreaterThanOrEqual(232);
		expect(menu.style.bottom).toBe("auto");
		expect(num(menu.style.left)).toBe(400);
	});
});
