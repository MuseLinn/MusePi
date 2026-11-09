import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppRail, type RailItem } from "../src/components/AppRail";

/**
 * Hover-peek starts on ONE destination button that declares `panelId`
 * (2026-11-08). Regression target: the handlers used to live on the whole
 * <nav>, so resting the pointer anywhere on the rail floated the 首页 session
 * list — including while the user was looking at 任务中心, whose own panel
 * could never float at all.
 */

const mounted = new Set<Root>();
afterEach(async () => {
	for (const root of mounted) await act(async () => root.unmount());
	mounted.clear();
	document.body.innerHTML = "";
});

async function mount(ui: React.ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mounted.add(root);
	await act(async () => root.render(ui));
	return container;
}

function reactHandler(element: Element, name: string): (() => void) | undefined {
	const key = Object.keys(element).find(candidate => candidate.startsWith("__reactProps$"));
	if (!key) return undefined;
	const props = (element as unknown as Record<string, Record<string, unknown>>)[key];
	return props?.[name] as (() => void) | undefined;
}

function destinations(): RailItem[] {
	return [
		{ id: "home", label: "general.home", icon: "home", panelId: "home", onSelect() {} },
		{
			id: "scheduled",
			label: "settings.scheduledTasks",
			icon: "calendar-schedule",
			panelId: "scheduled",
			onSelect() {},
		},
		{ id: "board", label: "settings.board", icon: "layout-column", onSelect() {} },
		// Plugin-gated in the real rail; included here to pin that a third
		// destination with its own panel peeks THAT panel, not 首页's list.
		{ id: "capability", label: "tools.capabilityCenter", icon: "star", panelId: "capability", onSelect() {} },
	];
}

function renderRail(overrides: { onPeekPanel?(id: string): void; onPeekEnd?(): void }) {
	return createElement(AppRail, {
		destinations: destinations(),
		settings: { id: "settings", label: "settings.settings", icon: "settings-3", onSelect() {} },
		panelAvailable: true,
		onTogglePanel() {},
		...overrides,
	});
}

describe("AppRail hover-peek", () => {
	it("reports the panel owned by the hovered destination, not the rail", async () => {
		const peeked: string[] = [];
		const container = await mount(renderRail({ onPeekPanel: id => peeked.push(id) }));
		const nav = container.querySelector("nav.gui-rail")!;
		const buttons = [...container.querySelectorAll<HTMLElement>("[data-rail-destination]")];

		// The rail's empty band (and its top spacer) carries no hover handler.
		expect(reactHandler(nav, "onPointerEnter")).toBeUndefined();
		expect(reactHandler(container.querySelector(".gui-rail-top")!, "onPointerEnter")).toBeUndefined();

		for (const [index, expected] of [
			[0, "home"],
			[1, "scheduled"],
			[3, "capability"],
		] as const) {
			const enter = reactHandler(buttons[index]!, "onPointerEnter");
			expect(enter).toBeDefined();
			await act(async () => enter!());
			expect(peeked.at(-1)).toBe(expected);
		}

		// A destination without a panel must not start a peek.
		expect(buttons[2]?.getAttribute("data-rail-panel")).toBeNull();
		expect(reactHandler(buttons[2]!, "onPointerEnter")).toBeUndefined();
		expect(peeked).toEqual(["home", "scheduled", "capability"]);
	});

	it("ends the peek only when a panel-bearing button is left", async () => {
		let ends = 0;
		const container = await mount(renderRail({ onPeekEnd: () => ends++ }));
		const buttons = [...container.querySelectorAll<HTMLElement>("[data-rail-destination]")];
		expect(reactHandler(buttons[0]!, "onPointerLeave")).toBeDefined();
		expect(reactHandler(buttons[2]!, "onPointerLeave")).toBeUndefined();
		await act(async () => reactHandler(buttons[0]!, "onPointerLeave")!());
		expect(ends).toBe(1);
	});
});
