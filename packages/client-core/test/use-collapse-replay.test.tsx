import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";

// A real DOM is required (the hook measures scrollHeight), and it must be
// registered BEFORE the module under test evaluates: its graph touches DOM
// globals at module scope. Registered here rather than through a shim import
// because import sorting would hoist a side-effecting import above nothing —
// it must stay last. Unregistered afterwards so a later file's `localStorage`
// is not replaced.
const dom = await import("@happy-dom/global-registrator");
dom.GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { collapseStyle, useCollapseHeight } = await import("../src/lib/use-collapse");

afterAll(() => {
	void dom.GlobalRegistrator.unregister();
});

/**
 * settle-on-replay: an effect whose cleanup ran while its DOM survived must not
 * re-measure on replay.
 *
 * The failure it defends: a collapse mid-animation when its effect was torn down
 * (StrictMode's double invoke, a suspense boundary revealing, the transcript
 * virtualizer re-mounting a row). The old animation stopped, but the ref still
 * recorded the target, so the replayed setup took the measure branch and pinned
 * whatever height the element had at that moment — leaving a blank region where
 * the content used to be.
 */

const roots: Array<ReturnType<typeof createRoot>> = [];

function Collapsible({
	open,
	bodyRef,
	previewPx,
	durationMs,
}: {
	open: boolean;
	bodyRef: ReturnType<typeof createRef<HTMLDivElement>>;
	/** Stands in for the caller's clamped-preview height, when it has one. */
	previewPx?: number;
	/** Part of the hook's dependency list, so changing it re-runs the effect. */
	durationMs?: number;
}): ReactNode {
	useCollapseHeight(
		open,
		bodyRef,
		durationMs === undefined
			? previewPx === undefined
				? {}
				: { closedHeight: () => previewPx }
			: { ...(previewPx === undefined ? {} : { closedHeight: () => previewPx }), durationMs },
	);
	return createElement("div", {
		ref: bodyRef,
		className: "tv-body",
		style: collapseStyle(open),
		children: "content",
	});
}

/** What the hook last wrote — i.e. the height CSS will render. */
function renderedHeight(body: HTMLDivElement): string {
	return body.style.getPropertyValue("--h");
}

/** happy-dom has no layout, so `scrollHeight` reads 0; give the body a real one. */
function withMeasuredHeight(body: HTMLDivElement, px: number): void {
	Object.defineProperty(body, "scrollHeight", { configurable: true, get: () => px });
	Object.defineProperty(body, "offsetHeight", { configurable: true, get: () => px });
}

/**
 * Mount once, then re-render the SAME root and the SAME ref: the body element
 * survives across renders, which is what makes an effect replay observable.
 */
function mount(
	open: boolean,
	previewPx?: number,
	durationMs?: number,
): { body: HTMLDivElement; set(nextOpen: boolean, nextDurationMs?: number): void } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	const bodyRef = createRef<HTMLDivElement>();
	act(() => root.render(createElement(Collapsible, { open, bodyRef, previewPx, durationMs })));
	const body = host.querySelector<HTMLDivElement>(".tv-body");
	if (!body) throw new Error("collapsible did not render a body");
	return {
		body,
		set(nextOpen: boolean, nextDurationMs = durationMs) {
			act(() =>
				root.render(createElement(Collapsible, { open: nextOpen, bodyRef, previewPx, durationMs: nextDurationMs })),
			);
		},
	};
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
});

describe("useCollapseHeight settle-on-replay", () => {
	test("first mount lands directly on the target, without measuring", () => {
		// Measuring on the first paint would animate from an unknown height and
		// flash; the inline `--h` already carries the state.
		const { body } = mount(false);
		withMeasuredHeight(body, 400);
		expect(renderedHeight(body)).toBe("0px");
	});

	test("a collapse ends at the closed height after measuring", () => {
		const { body, set } = mount(true);
		withMeasuredHeight(body, 400);
		expect(renderedHeight(body)).toBe("auto");

		set(false);
		expect(renderedHeight(body)).toBe("0px");
	});

	test("a replayed effect with the same state settles instead of re-measuring", () => {
		// After the collapse settles at 0, a replay must not pin `scrollHeight`
		// again: on a collapsed element that measures the collapsed height, and
		// the pinned value can outlive the content it described.
		const { body, set } = mount(true);
		withMeasuredHeight(body, 400);

		set(false);
		expect(renderedHeight(body)).toBe("0px");

		set(false); // same state: a replay, not a transition
		expect(renderedHeight(body)).toBe("0px");
	});

	test("a replay on a preview-clamped body keeps the preview height", () => {
		// The long-user-message case: `closedHeight` returns the 2-line preview.
		// A replay must keep settling to that preview, never to the full content
		// height measured mid-collapse.
		const previewPx = 56;
		const { body, set } = mount(true, previewPx);
		withMeasuredHeight(body, 400);

		set(false);
		expect(renderedHeight(body)).toBe(`${previewPx}px`);

		set(false);
		expect(renderedHeight(body)).toBe(`${previewPx}px`);
	});

	test("a real state change still animates — the guard does not swallow transitions", () => {
		const { body, set } = mount(false);
		withMeasuredHeight(body, 400);

		set(true);
		// Expand measures the natural height on the way to auto.
		expect(renderedHeight(body)).toBe("400px");
		// It settles to auto once the transition ends (transitionend, or the
		// hook's own timeout where the browser fires none), so streamed content
		// keeps growing.
		expect(renderedHeight(body)).not.toBe("auto");
	});

	test("an effect that re-runs on unchanged state settles to auto instead of re-measuring", () => {
		// The replay this guards is a REAL effect re-run with the same `open`:
		// StrictMode's double invoke, a suspense reveal, or the transcript
		// virtualizer re-mounting a row all re-run setup while the DOM survives.
		// Re-measuring here would pin a pixel height and clip the rest of the
		// turn's streamed content.
		const { body, set } = mount(false, undefined, 220);
		withMeasuredHeight(body, 400);

		set(true, 220);
		expect(renderedHeight(body)).toBe("400px");

		// Same `open`, but `durationMs` changed — a dependency, so the effect
		// genuinely re-runs. The guard must settle, not measure again.
		set(true, 400);
		expect(renderedHeight(body)).toBe("auto");
	});
});
