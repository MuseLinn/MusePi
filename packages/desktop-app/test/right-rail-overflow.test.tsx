import "./happy-dom-shim"; // MUST be first: component module graphs touch DOM globals at evaluation time.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RightRail } from "../src/components/RightRail";
import { SURFACE_HIDDEN_KEY } from "../src/lib/surfaces/registry";

/**
 * Right-rail "…" (more tools) overflow menu — two contracts that regressed
 * together (user report 2026-10-18):
 *
 * 1. **Unclipped.** The rail is a 44px card with `overflow: hidden`. The menu
 *    used to be a `position: absolute; right: 48px` child of the rail, so it
 *    painted entirely outside the clip and clicking "…" showed nothing. The
 *    fix routes it through `useFloatingMenu`, which portals a `position: fixed`
 *    wrapper into the React root — the one place no rail ancestor can clip.
 *    Asserting the portalled wrapper's ancestry is what makes the regression
 *    observable: a re-introduced in-rail menu would attach under
 *    `.gui-right-rail` and fail here, with no layout or vision needed.
 *
 * 2. **Localized.** The trigger carried literal `title="more tools"` /
 *    `aria-label="more tools"`. The accessible name is read by screen readers,
 *    so it must resolve through the dictionary like every other rail label.
 */

const originalLocale = getLocaleSnapshot();
const mounted: { host: HTMLDivElement; root: Root }[] = [];

beforeEach(() => {
	// One hidden surface guarantees `hiddenItems.length > 0`, so the "…" trigger
	// always renders regardless of how many surfaces fit the rail height.
	localStorage.setItem(SURFACE_HIDDEN_KEY, JSON.stringify(["widget"]));
});

afterEach(() => {
	while (mounted.length > 0) {
		const entry = mounted.pop();
		if (!entry) continue;
		act(() => entry.root.unmount());
		entry.host.remove();
	}
	document.body.innerHTML = "";
	localStorage.clear();
});

afterAll(() => {
	setLocale(originalLocale);
});

/**
 * Mounts RightRail into `#root` — the same container the real shell uses, so
 * the portal target the floating menu resolves is the production one and the
 * menu lands as a SIBLING of the rail rather than inside it.
 */
function renderRail(): HTMLDivElement {
	const rootHost = document.createElement("div");
	rootHost.id = "root";
	document.body.appendChild(rootHost);
	const root = createRoot(rootHost);
	mounted.push({ host: rootHost, root });
	act(() => {
		root.render(
			createElement(RightRail, {
				rpc: null,
				sessionId: null,
				cwd: "C:\\proj",
				rightPanelOpen: true,
				onSelect: () => {},
			}),
		);
	});
	return rootHost;
}

function railOf(rootHost: HTMLElement): HTMLElement {
	const rail = rootHost.querySelector<HTMLElement>(".gui-right-rail");
	if (!rail) throw new Error("RightRail did not render");
	return rail;
}

/** The "…" trigger is the only rail button declaring a menu popup. */
function overflowTrigger(rail: HTMLElement): HTMLButtonElement {
	const button = rail.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
	if (!button) throw new Error("the rail rendered no overflow trigger");
	return button;
}

function openOverflow(rail: HTMLElement): void {
	const button = overflowTrigger(rail);
	act(() => button.click());
}

describe("right-rail overflow menu", () => {
	test("the menu mounts OUTSIDE the clipping rail card", () => {
		const rootHost = renderRail();
		const rail = railOf(rootHost);

		openOverflow(rail);

		const menu = rootHost.querySelector<HTMLElement>(".gui-right-rail-overflow");
		expect(menu).not.toBeNull();
		// The whole point: the menu is NOT a descendant of the rail. Anything
		// inside `.gui-right-rail` is subject to its `overflow: hidden`.
		expect(rail.contains(menu!)).toBe(false);
		expect(menu!.closest(".gui-right-rail")).toBeNull();
	});

	test("the portalled menu exposes the folded/hidden surfaces", () => {
		setLocale("zh-CN");
		const rootHost = renderRail();
		openOverflow(railOf(rootHost));

		// This is the content the user could not see at all while the menu was
		// clipped: the hidden-surface restore section and its entries, resolved
		// through the dictionary (not raw keys).
		const items = rootHost.querySelectorAll("[role='menuitem']");
		expect(items.length).toBeGreaterThan(0);
		expect(rootHost.textContent).toContain("显示已隐藏的表面");
		expect(rootHost.textContent).toContain("组件预览");
	});

	test("closing the menu removes it from the root", () => {
		const rootHost = renderRail();
		const rail = railOf(rootHost);
		openOverflow(rail);
		expect(rootHost.querySelector(".gui-right-rail-overflow")).not.toBeNull();

		// The trigger toggles; a second press is the user's other way out.
		openOverflow(rail);

		// The exit animation keeps the node mounted for CLOSE_MS; the wrapper
		// flips to --closing immediately, which is the observable close signal.
		const menu = rootHost.querySelector<HTMLElement>(".gui-right-rail-overflow");
		expect(menu === null || menu.classList.contains("gui-menu-popup--closing")).toBe(true);
	});

	test("Escape closes the menu and claims the key", () => {
		const rootHost = renderRail();
		openOverflow(railOf(rootHost));
		expect(rootHost.querySelector(".gui-right-rail-overflow")).not.toBeNull();

		// Escape is owned by useFloatingMenu; it must preventDefault so the
		// window-level bare-Escape binding does not interrupt the running turn
		// (docs/gui-implementation.md §"Escape ownership").
		const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		act(() => {
			document.dispatchEvent(escEvent);
		});
		expect(escEvent.defaultPrevented).toBe(true);
	});

	test("the trigger's accessible name resolves through the dictionary", () => {
		setLocale("zh-CN");
		const rootHost = renderRail();
		const button = overflowTrigger(railOf(rootHost));

		expect(button.getAttribute("aria-label")).toBe("更多工具");
		expect(button.getAttribute("title")).toBe("更多工具");
		expect(button.getAttribute("aria-label")).not.toBe("more tools");
	});

	test("the rail landmark itself is localized", () => {
		setLocale("zh-CN");
		const rail = railOf(renderRail());
		expect(rail.getAttribute("aria-label")).toBe("右侧工具栏");
	});
});
