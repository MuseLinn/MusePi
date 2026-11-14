import "./happy-dom-shim"; // MUST be first: component module graphs define HTMLElement subclasses at evaluation time.
import { afterAll, describe, expect, test } from "bun:test";
import { setLocale } from "@musepi/client-core";
import type { ReactNode } from "react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AppRail, type RailItem } from "../src/components/AppRail";

/**
 * App rail contract (two-tier shell): the rail is the panel's permanent
 * driver. These assertions pin the parts the panel depends on —
 *  * exactly one destination is "current" (aria-current), so the panel can
 *    never render two views at once;
 *  * double-click on the rail background toggles the panel, but a fast
 *    double-tap on a destination must NOT also collapse it;
 *  * the top band is EMPTY and a real element: destinations start below the
 *    window header, and the rail never renders a second fold control next to
 *    the fixed titlebar cluster (regression 2026-11-08: duplicate button);
 *  * a page destination has no panel: the double-click gesture is inert
 *    rather than doing something invisible;
 *  * the unread dot is decorative and never becomes the accessible name;
 *  * footer actions (instance / shortcuts / remote) mount in the rail's
 *    bottom group so folding the panel cannot hide them.
 */

setLocale("zh-CN");
afterAll(() => {
	setLocale("en-US");
});

function renderRail(
	overrides: { activeId?: string; unreadId?: string; panelAvailable?: boolean; footerActions?: ReactNode } = {},
) {
	const calls: string[] = [];
	let toggles = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	const item = (id: string, active = false, unread = false): RailItem => ({
		id,
		label: "general.sessions",
		icon: "chat-1",
		active: overrides.activeId === id || active,
		unread: overrides.unreadId === id || unread,
		onSelect: () => calls.push(id),
	});
	act(() => {
		root.render(
			createElement(AppRail, {
				destinations: [item("home"), item("board")],
				settings: item("settings"),
				footerActions: overrides.footerActions,
				panelAvailable: overrides.panelAvailable ?? true,
				onTogglePanel: () => {
					toggles += 1;
				},
			}),
		);
	});
	const nav = host.querySelector("nav");
	if (!(nav instanceof HTMLElement)) throw new Error("rail did not render a <nav>");
	return {
		nav,
		calls,
		toggles: () => toggles,
		root,
		host,
		button: (id: string): HTMLButtonElement => {
			const el = nav.querySelector(`[data-rail-destination="${id}"]`);
			if (!(el instanceof HTMLButtonElement)) throw new Error(`no rail button ${id}`);
			return el;
		},
		toggleCount: () => nav.querySelectorAll('[data-rail-toggle="panel"]').length,
		unmount: () => {
			act(() => root.unmount());
			host.remove();
		},
	};
}

describe("AppRail", () => {
	test("nav landmark carries the app-navigation label", () => {
		const rail = renderRail();
		expect(rail.nav.getAttribute("aria-label")).toBe("应用导航");
		expect(rail.nav.className).toContain("gui-rail");
		rail.unmount();
	});

	test("only the active destination is aria-current", () => {
		const rail = renderRail({ activeId: "board" });
		expect(rail.button("board").getAttribute("aria-current")).toBe("page");
		expect(rail.button("home").hasAttribute("aria-current")).toBe(false);
		expect(rail.nav.querySelectorAll('[aria-current="page"]').length).toBe(1);
		rail.unmount();
	});

	test("the rail renders no second fold control next to the titlebar cluster", () => {
		const rail = renderRail();
		expect(rail.toggleCount()).toBe(0);
		const top = rail.nav.querySelector(".gui-rail-top");
		expect(top).not.toBeNull();
		expect(top?.querySelectorAll("button").length).toBe(0);
		expect(top?.getAttribute("aria-hidden")).toBe("true");
		rail.unmount();
	});

	test("a destination click selects instead of toggling", () => {
		const rail = renderRail();
		act(() => rail.button("board").click());
		expect(rail.calls).toEqual(["board"]);
		expect(rail.toggles()).toBe(0);
		rail.unmount();
	});

	test("double-click on rail background toggles the panel", () => {
		const rail = renderRail();
		act(() => {
			rail.nav.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(rail.toggles()).toBe(1);
		rail.unmount();
	});

	test("double-click on a destination does not toggle the panel", () => {
		const rail = renderRail();
		act(() => {
			rail.button("home").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(rail.toggles()).toBe(0);
		rail.unmount();
	});

	test("the top band keeps destinations below the window header", () => {
		const rail = renderRail();
		const top = rail.nav.querySelector(".gui-rail-top");
		expect(top).not.toBeNull();
		const scroll = rail.nav.querySelector(".gui-rail-scroll");
		expect(scroll?.contains(rail.button("home"))).toBe(true);
		expect(top?.contains(rail.button("home"))).toBe(false);
		rail.unmount();
	});

	test("a page destination has no inert double-click", () => {
		const rail = renderRail({ panelAvailable: false });
		expect(rail.toggleCount()).toBe(0);
		act(() => {
			rail.nav.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(rail.toggles()).toBe(0);
		// Destinations themselves stay live — 首页 is the way back to a panel.
		act(() => rail.button("home").click());
		expect(rail.calls).toEqual(["home"]);
		rail.unmount();
	});

	test("footer actions live in the rail's bottom group, not the foldable panel", () => {
		const rail = renderRail({
			footerActions: createElement("button", { type: "button", "data-rail-footer": "instance" }, "实例"),
		});
		const footer = rail.nav.querySelector('[data-rail-footer="instance"]');
		expect(footer).not.toBeNull();
		const group = rail.nav.querySelector(".gui-rail-group");
		expect(group?.contains(footer as Element)).toBe(true);
		expect(rail.nav.querySelector(".gui-rail-scroll")?.contains(footer as Element)).toBe(false);
		rail.unmount();
	});

	test("unread dot is decorative, not part of the accessible name", () => {
		const rail = renderRail({ unreadId: "home" });
		const dot = rail.button("home").querySelector(".gui-rail-dot");
		expect(dot).not.toBeNull();
		expect(dot?.getAttribute("aria-hidden")).toBe("true");
		expect(rail.button("home").getAttribute("aria-label")).toBe("会话");
		expect(rail.button("board").querySelector(".gui-rail-dot")).toBeNull();
		rail.unmount();
	});
});
