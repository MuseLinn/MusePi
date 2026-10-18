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

const FOLD_WAIT_MS = 300;
/** Height the fold collapses by, i.e. how far the anchor would drift. */
const FOLD_H = 400;
/**
 * Where the header sits relative to the viewport. Two values per test: BEFORE
 * the close (fold open, taller layout) and AFTER (fold closed, everything under
 * it moved up by FOLD_H) — that drift is exactly what the hook cancels.
 */
let headerTop = -50;
let headerTopAfterClose = -50;

const roots: Array<ReturnType<typeof createRoot>> = [];

/**
 * The hook under test, wired to a header inside a fold. The fold is built once
 * per mount (not per render) so React re-renders move the SAME element — that
 * is what makes the open→close transition observable.
 *
 * Structure mirrors the transcript: the scroller holds the header button and
 * the fold's height-carrying slot as siblings, which is the relationship the
 * hook's lookup depends on.
 */
function FoldHarness({ open }: { open: boolean }): ReactNode {
	const ref = useHoldAnchor(open);
	return createElement(
		"div",
		{ "data-transcript-scroller": "" },
		createElement("button", { ref, type: "button", className: "tr-round-fold" }),
		createElement("div", { className: "tr-fold-slot" }),
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
	// contract is about. The header's box changes once the fold is closed:
	// the slot above it collapses, so the header (and everything under it)
	// moves up by FOLD_H.
	Object.defineProperty(header, "getBoundingClientRect", {
		configurable: true,
		value: () => ({ top: headerTop, bottom: headerTop + 20, height: 20 }) as DOMRect,
	});
	Object.defineProperty(slot, "getBoundingClientRect", {
		configurable: true,
		value: () => ({ top: headerTop - FOLD_H, bottom: headerTop, height: FOLD_H }) as DOMRect,
	});
	Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
	return { header, scroller };
}

/**
 * Apply the post-close geometry: the fold's height is gone, so the header and
 * everything below it sit FOLD_H higher — the drift the hook must cancel.
 */
function applyClosedGeometry(header: HTMLButtonElement, scroller: HTMLElement): void {
	const slot = scroller.querySelector<HTMLElement>(".tr-fold-slot");
	if (!slot) throw new Error("fold slot vanished");
	Object.defineProperty(header, "getBoundingClientRect", {
		configurable: true,
		value: () => ({ top: headerTopAfterClose, bottom: headerTopAfterClose + 20, height: 20 }) as DOMRect,
	});
	Object.defineProperty(slot, "getBoundingClientRect", {
		configurable: true,
		value: () => ({ top: 0, bottom: 0, height: 0 }) as DOMRect,
	});
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
	headerTopAfterClose = -50;
});

describe("holdAnchor", () => {
	test("closing a fold above the reader pins the content below it", async () => {
		const { header, scroller } = mountFold(true);
		// The fold is entirely above the viewport, so closing it would push the
		// reply the reader is on up by FOLD_H.
		headerTop = -50;
		headerTopAfterClose = -50 + FOLD_H;

		rerender(false);
		// The layout after the fold's height transition: the header drifted up.
		applyClosedGeometry(header, scroller);
		// The hook's timer waits out the fold's height transition before
		// correcting, so a mid-animation height is not measured.
		await new Promise(r => setTimeout(r, FOLD_WAIT_MS));

		// The scroll position was corrected by the amount the fold shrank, so
		// the reader stays on the same content.
		expect(scroller.scrollTop).toBe(FOLD_H);
	});

	test("a fold still in view animates instead of snapping", async () => {
		const { header, scroller } = mountFold(true);
		// The fold overlaps the viewport: the reader can SEE it collapse, which
		// is the animation they expect — correcting would feel like a jump.
		headerTop = 20;
		headerTopAfterClose = 20 + FOLD_H;
		// The slot's top is what the hook tests; keep it in view.
		Object.defineProperty(scroller.querySelector(".tr-fold-slot")!, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ top: 0, bottom: FOLD_H, height: FOLD_H }) as DOMRect,
		});

		rerender(false);
		applyClosedGeometry(header, scroller);
		await new Promise(r => setTimeout(r, FOLD_WAIT_MS));

		expect(scroller.scrollTop).toBe(0);
	});

	test("opening never moves the reader, whatever its position", async () => {
		const { scroller } = mountFold(false);

		rerender(true);
		await new Promise(r => setTimeout(r, FOLD_WAIT_MS));

		expect(scroller.scrollTop).toBe(0);
	});
});
