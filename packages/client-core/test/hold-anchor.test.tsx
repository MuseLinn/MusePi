// biome-ignore-all assist/source/organizeImports: import order below is
// load-bearing — the DOM must be registered before the module under test
// evaluates, so the dynamic imports deliberately follow the static ones.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

// A real DOM is required for geometry (getBoundingClientRect), and it must be
// registered BEFORE the module under test evaluates: that graph defines
// HTMLElement subclasses at module scope, so a static import would evaluate it
// against the bare globals. Registered here rather than through a shim import
// because import sorting would hoist a side-effecting import above nothing —
// it must stay last.
const dom = await import("@happy-dom/global-registrator");
dom.GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { useHoldAnchor } = await import("../src/components/transcript/use-hold-anchor");

// Unregistered afterwards: a registered DOM replaces the global localStorage,
// which poisons later files in the same process that read it directly.
afterAll(() => {
	void dom.GlobalRegistrator.unregister();
});

/**
 * holdAnchor: a fold that closes entirely ABOVE the reader must not move the
 * content under them.
 *
 * Without the correction the reply they were reading jumps up by the fold's
 * height — the transcript scroller disables browser scroll anchoring (it
 * virtualizes), so nothing else compensates. The fold in view must still
 * animate normally, which is the second half of the contract.
 */

/** Height the fold collapses by, i.e. how far the anchor would drift. */
const FOLD_H = 400;
/** Where the reader was scrolled to, so the correction is a visible delta. */
const READER_SCROLL = 1000;
/**
 * Where the header sits relative to the viewport. Two values per test: while
 * the slot's height transition is armed (fold open, taller layout) and once it
 * is muted (fold collapsed, everything under it moved up by FOLD_H) — that
 * drift is exactly what the hook cancels.
 */
let headerTop = -50;
let headerTopAfterClose = -50 - FOLD_H;

const roots: Array<ReturnType<typeof createRoot>> = [];

function box(top: number, height: number): DOMRect {
	return {
		top,
		bottom: top + height,
		height,
		left: 0,
		right: 0,
		width: 0,
		x: 0,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

/**
 * The hook under test, wired to a header inside a fold. The fold is built once
 * per mount (not per render) so React re-renders move the SAME element — that
 * is what makes the open→close transition observable.
 *
 * Structure mirrors the transcript: the scroller owns both the fold header and
 * the height-carrying slot the closed turn renders, and `open` drives the
 * slot's `--open` class exactly like the real fold does.
 */
function FoldHarness({ open }: { open: boolean }): ReactNode {
	const ref = useHoldAnchor(open);
	return createElement(
		"div",
		{ "data-transcript-scroller": "" },
		createElement("button", { ref, type: "button", className: "tr-round-fold" }),
		createElement("div", { className: `tr-fold-slot${open ? " tr-fold-slot--open" : ""}` }),
	);
}

function mountFold(open: boolean): { header: HTMLButtonElement; scroller: HTMLElement } {
	const el = document.createElement("div");
	document.body.appendChild(el);
	const root = createRoot(el);
	roots.push(root);
	act(() => root.render(createElement(FoldHarness, { open })));

	const scroller = el.querySelector<HTMLElement>("[data-transcript-scroller]");
	const header = scroller?.querySelector<HTMLButtonElement>("button");
	const slot = scroller?.querySelector<HTMLElement>(".tr-fold-slot");
	if (!scroller || !header || !slot) throw new Error("harness did not render the fold");
	// happy-dom lays nothing out, so give the three elements the boxes the
	// contract is about. The fold's height lives in the slot, ABOVE the header
	// the hook anchors on, and closing it moves the header (and the reply it
	// rides once closed) up by FOLD_H.
	//
	// The closed geometry is reported once the hook mutes the slot's transition,
	// which is how a browser behaves: until that inline style lands, the
	// transition still reports the open height, and the hook's forced layout
	// reads the collapsed one. Keying the mock off the style is what lets a
	// layout-effect pin observe any drift at all.
	const collapsed = (): boolean => slot.style.transition === "none";
	Object.defineProperty(header, "getBoundingClientRect", {
		configurable: true,
		value: () => box(collapsed() ? headerTopAfterClose : headerTop, 20),
	});
	Object.defineProperty(slot, "getBoundingClientRect", {
		configurable: true,
		value: () => (collapsed() ? box(headerTopAfterClose - FOLD_H, 0) : box(headerTop - FOLD_H, FOLD_H)),
	});
	Object.defineProperty(scroller, "getBoundingClientRect", {
		configurable: true,
		value: () => box(0, 800),
	});
	Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: READER_SCROLL });
	return { header, scroller };
}

function rerender(open: boolean): void {
	const root = roots[roots.length - 1];
	act(() => root.render(createElement(FoldHarness, { open })));
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	headerTop = -50;
	headerTopAfterClose = -50 - FOLD_H;
});

describe("holdAnchor", () => {
	test("closing a fold above the reader pins the content below it", () => {
		const { scroller } = mountFold(true);
		// The fold ends above the visible top, so closing it would push the
		// reply the reader is on up by FOLD_H.
		headerTop = -50;
		headerTopAfterClose = headerTop - FOLD_H;

		rerender(false);

		// The scroll position was corrected by the amount the fold shrank, so
		// the reader stays on the same content.
		expect(scroller.scrollTop).toBe(READER_SCROLL - FOLD_H);
	});

	test("a fold still in view animates instead of snapping", () => {
		const { scroller } = mountFold(true);
		// The fold overlaps the viewport: the reader can SEE it collapse, which
		// is the animation they expect — correcting would feel like a jump.
		headerTop = 20;
		headerTopAfterClose = headerTop - FOLD_H;

		rerender(false);

		expect(scroller.scrollTop).toBe(READER_SCROLL);
	});

	test("opening never moves the reader, whatever its position", () => {
		const { scroller } = mountFold(false);

		rerender(true);

		expect(scroller.scrollTop).toBe(READER_SCROLL);
	});
});
