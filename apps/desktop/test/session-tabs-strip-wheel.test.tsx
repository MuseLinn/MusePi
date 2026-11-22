import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionTabsStrip } from "../src/components/SessionTabsStrip";

/**
 * Header tab strip scrolling (`SessionTabsStrip`).
 *
 * Geometry and the hidden indicator are covered against the real cascade in
 * `tab-strip-geometry.test.ts`; what cannot be observed from CSS is the wheel
 * mapping. The strip is horizontal, so a vertical wheel gesture must move it:
 * that handler is the only way a mouse user reaches tabs past the edge, and
 * deleting it alongside the indicator would leave the overflow unreachable.
 *
 * The DOM here is happy-dom, whose `scrollLeft` setter does not implement the
 * CSS overflow behaviour — so the assertions read the value the handler wrote,
 * which is exactly the contract ("map this gesture to horizontal travel").
 */

function testInEnglish(name: string, run: () => void): void {
	test(name, () => {
		const previous = getLocaleSnapshot();
		setLocale("en-US");
		try {
			run();
		} finally {
			setLocale(previous);
		}
	});
}

const mounted: Root[] = [];
const hosts: HTMLElement[] = [];

const tabs = [
	{ id: "a", label: "Alpha", working: false, unread: false },
	{ id: "b", label: "Bravo", working: false, unread: false },
	{ id: "c", label: "Charlie", working: false, unread: false },
];

function renderStrip(): { host: HTMLElement; strip: HTMLElement } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	mounted.push(root);
	act(() => {
		root.render(
			<SessionTabsStrip
				tabs={tabs}
				activeId="a"
				previewTabId={null}
				onSelect={() => {}}
				onKeepOpen={() => {}}
				onRename={() => {}}
				onCopyId={() => {}}
				onExport={() => {}}
				onOpenMiniChat={() => {}}
				onMoveToWorktree={() => {}}
				onArchive={() => {}}
				onDelete={() => {}}
				onCloseOthers={() => {}}
				onClose={() => {}}
				onReorder={() => {}}
			/>,
		);
	});
	const strip = host.querySelector<HTMLElement>(".gui-session-tabs-scroll");
	expect(strip).not.toBeNull();
	return { host, strip: strip! };
}

function wheel(
	node: HTMLElement,
	init: WheelEventInit,
	modifiers: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey", boolean>> = {},
): void {
	// happy-dom's WheelEvent constructor drops modifier flags, so define them
	// explicitly; the handler reads the same properties in a real browser.
	const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
	for (const [key, value] of Object.entries(modifiers)) {
		Object.defineProperty(event, key, { value, configurable: true });
	}
	act(() => {
		node.dispatchEvent(event);
	});
}

afterEach(() => {
	while (mounted.length > 0) {
		const root = mounted.pop();
		if (root) act(() => root.unmount());
	}
	while (hosts.length > 0) hosts.pop()?.remove();
});

describe("SessionTabsStrip wheel scrolling", () => {
	testInEnglish("a vertical wheel moves the strip horizontally", () => {
		const { strip } = renderStrip();
		strip.scrollLeft = 0;
		wheel(strip, { deltaY: 120, deltaX: 0 });
		expect(strip.scrollLeft).toBe(120);
		wheel(strip, { deltaY: -40, deltaX: 0 });
		expect(strip.scrollLeft).toBe(80);
	});

	testInEnglish("line-mode deltas are converted to pixels", () => {
		const { strip } = renderStrip();
		strip.scrollLeft = 0;
		// Firefox reports lines; 3 lines × 16px.
		wheel(strip, { deltaY: 3, deltaX: 0, deltaMode: WheelEvent.DOM_DELTA_LINE });
		expect(strip.scrollLeft).toBe(48);
	});

	testInEnglish("native horizontal gestures pass through untouched", () => {
		const { strip } = renderStrip();
		strip.scrollLeft = 0;
		wheel(strip, { deltaY: 60, deltaX: 140 });
		expect(strip.scrollLeft).toBe(0);
	});

	testInEnglish("Shift and Ctrl/Cmd wheels keep their own meaning", () => {
		const { strip } = renderStrip();
		strip.scrollLeft = 0;
		wheel(strip, { deltaY: 120, deltaX: 0 }, { shiftKey: true });
		wheel(strip, { deltaY: 120, deltaX: 0 }, { ctrlKey: true });
		wheel(strip, { deltaY: 120, deltaX: 0 }, { metaKey: true });
		expect(strip.scrollLeft).toBe(0);
	});

	testInEnglish("the strip keeps its overflow and hides only the indicator", () => {
		const { strip } = renderStrip();
		// The class contract lives in gui-chat.css; the element must be the
		// scroll container the CSS rules target (not a wrapper around it).
		expect(strip.className).toContain("gui-session-tabs-scroll");
		expect(strip.getAttribute("role")).toBeNull();
		expect(strip.querySelectorAll("[role='tab']")).toHaveLength(3);
	});
});
