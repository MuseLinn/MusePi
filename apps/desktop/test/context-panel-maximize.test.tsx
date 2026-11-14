import "./happy-dom-shim";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextPanel } from "../src/components/ContextPanel";
import { getPanelMaximized, installPanelMaximizeController, setPanelMaximized } from "../src/lib/panel-maximize";
import type { PanelTab } from "../src/lib/panel-tabs";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
const rpc = { request: async () => null, addEventListener: () => () => {} } as unknown as RpcClient;
const agentsTab: PanelTab = {
	id: "agents::",
	surface: "agents",
	target: null,
	label: "Agents",
	readOnly: false,
	touchedAt: 1,
	dedupeKey: null,
	dirty: false,
	preview: false,
	column: 0,
};
const secondTab: PanelTab = { ...agentsTab, id: "agents::two", label: "Agents 2", touchedAt: 2 };
const panelTabs: UsePanelTabsResult = {
	tabs: [agentsTab],
	activeId: "agents::",
	split: false,
	columnActive: ["agents::", null],
	open: () => {},
	close: () => {},
	closeMany: () => {},
	duplicate: () => {},
	activate: () => {},
	reorder: () => {},
	moveToColumn: () => {},
	setSplit: () => {},
	setSplitRatio: () => {},
	setDirty: () => {},
};
const snap = {
	sessionId: "s1",
	entries: [],
	state: { cwd: "C:/workspace" },
	streaming: false,
	activeTools: new Map(),
	working: false,
	cursor: 0,
	agents: [],
	progress: new Map(),
	lifecycle: new Map(),
	unviewedCompleted: [],
	approvals: [],
	recap: null,
	roundDurations: new Map(),
} as unknown as GuiSessionState;

function rect(left: number, top: number, width: number, height: number): DOMRect {
	return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

interface MountOptions {
	open?: boolean;
	tabs?: PanelTab[];
	activeId?: string;
	/** A collapsed-panel session-info column docked beside the session. */
	sessionInfoDock?: boolean;
	/** Welcome scene: the visible card is `.gui-welcome-card`, and there is no
	 *  session column to measure unless `leavingColumn` keeps one mounted. */
	welcome?: boolean;
	/** The previous scene's session column, still mounted through the crossfade. */
	leavingColumn?: boolean;
}

function mountPanel(options: MountOptions = {}): {
	panel: HTMLElement;
	dockedWidth: number;
	transitions: string[];
	measures: DOMRect[];
	styleValues: Map<string, string>;
	rerender(next: MountOptions): void;
} {
	const surface = document.createElement("div");
	surface.className = "gui-chat-surface";
	if (options.sessionInfoDock) {
		const dock = document.createElement("div");
		dock.className = "gui-chat-column gui-session-info-dock";
		dock.getBoundingClientRect = () => rect(0, 0, 216, 700);
		surface.append(dock);
	}
	const column = document.createElement("div");
	column.className = "gui-chat-column";
	column.getBoundingClientRect = () => rect(272, 48, 1244, 700);
	const transcript = document.createElement("div");
	transcript.className = "gui-transcript-wrap";
	column.append(transcript);
	if (options.welcome) {
		const card = document.createElement("div");
		card.className = "gui-welcome-card";
		card.getBoundingClientRect = () => rect(96, 72, 1100, 640);
		surface.append(card);
		if (options.leavingColumn) {
			const scene = document.createElement("div");
			scene.className = "gui-scene gui-scene--leaving";
			scene.append(column);
			surface.append(scene);
		}
	} else {
		surface.append(column);
	}
	const host = document.createElement("div");
	surface.append(host);
	document.body.appendChild(surface);
	hosts.push(surface);
	const root = createRoot(host);
	roots.push(root);
	const render = (next: MountOptions = options): void => {
		act(() =>
			root.render(
				<ContextPanel
					snap={snap}
					rpc={rpc}
					open={next.open ?? true}
					onViewChange={() => {}}
					panelTabs={{
						...panelTabs,
						tabs: next.tabs ?? panelTabs.tabs,
						activeId: next.activeId ?? panelTabs.activeId,
					}}
					agentId={null}
					onAgentSelect={() => {}}
				/>,
			),
		);
	};
	render();
	const panel = document.querySelector<HTMLElement>(".gui-pane-right--inner")!;
	const dockedWidth = Number.parseFloat(panel.style.width);
	const transitions: string[] = [];
	const values = new Map<string, string>([["width", `${dockedWidth}px`]]);
	const style = {
		get left() {
			return values.get("left") ?? "";
		},
		set left(value: string) {
			values.set("left", value);
		},
		get top() {
			return values.get("top") ?? "";
		},
		set top(value: string) {
			values.set("top", value);
		},
		get width() {
			return values.get("width") ?? "";
		},
		set width(value: string) {
			values.set("width", value);
		},
		get height() {
			return values.get("height") ?? "";
		},
		set height(value: string) {
			values.set("height", value);
		},
		get transition() {
			return values.get("transition") ?? "";
		},
		set transition(value: string) {
			transitions.push(value);
			values.set("transition", value);
		},
		setProperty(property: string, value: string): void {
			values.set(property, value);
		},
		removeProperty(property: string): string {
			const previous = values.get(property) ?? "";
			values.delete(property);
			return previous;
		},
	} as CSSStyleDeclaration;
	Object.defineProperty(panel, "style", { value: style });
	const measures: DOMRect[] = [];
	let previousMaximized = false;
	panel.getBoundingClientRect = () => {
		const maximized = panel.classList.contains("gui-pane-right--maximized");
		// Chromium ignores an invalid transition replacement. The previous width
		// transition therefore still runs while FLIP measures its restore target.
		const transitioning = maximized !== previousMaximized && panel.style.transition !== "none";
		previousMaximized = maximized;
		const base = maximized || transitioning ? rect(272, 48, 1244, 700) : rect(900, 48, dockedWidth, 700);
		const width = panel.style.width ? Number.parseFloat(panel.style.width) : base.width;
		const height = panel.style.height ? Number.parseFloat(panel.style.height) : base.height;
		const anchoredLeft = maximized ? base.left : base.right - width;
		const left = panel.style.left
			? maximized
				? Number.parseFloat(panel.style.left)
				: anchoredLeft + Number.parseFloat(panel.style.left)
			: anchoredLeft;
		const top = panel.style.top
			? maximized
				? Number.parseFloat(panel.style.top)
				: base.top + Number.parseFloat(panel.style.top)
			: base.top;
		const measured = rect(left, top, width, height);
		measures.push(measured);
		return measured;
	};
	return { panel, dockedWidth, transitions, measures, styleValues: values, rerender: render };
}

function maximizeButton(panel: HTMLElement): HTMLButtonElement {
	return panel.querySelector<HTMLButtonElement>("[data-panel-maximize]")!;
}

function click(label: "maximize" | "restore"): void {
	const labels = label === "maximize" ? ["最大化面板", "Maximize panel"] : ["还原面板", "Restore panel"];
	const button = labels
		.map(text => document.querySelector<HTMLButtonElement>(`.gui-pane-tool[aria-label="${text}"]`))
		.find(candidate => candidate !== null)!;
	act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function finishFlip(panel: HTMLElement): void {
	const event = new Event("transitionend");
	Object.defineProperty(event, "propertyName", { value: "width" });
	act(() => panel.dispatchEvent(event));
}

const OriginalResizeObserver = globalThis.ResizeObserver;
let stopMaximizeListener: () => void;

beforeAll(async () => {
	// A sibling suite that installs test/dom-shim.ts leaves a stub `document` on
	// globalThis while happy-dom still reports registered, so this file's own
	// mount would build nodes without the element surface React needs.
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
});

beforeEach(() => {
	setPanelMaximized(false);
	stopMaximizeListener = installPanelMaximizeController();
	vi.spyOn(window, "matchMedia").mockReturnValue({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	} as unknown as MediaQueryList);
	globalThis.ResizeObserver = class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
});

afterEach(() => {
	stopMaximizeListener();
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
	globalThis.ResizeObserver = OriginalResizeObserver;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("ContextPanel maximize/restore", () => {
	it("restores the docked split geometry and can maximize again", () => {
		const { panel, dockedWidth, transitions, measures } = mountPanel();
		for (let cycle = 0; cycle < 2; cycle++) {
			const measureStart = measures.length;
			click("maximize");
			expect(measures[measureStart]?.left).toBe(900);
			expect(measures[measureStart]?.width).toBe(dockedWidth);
			expect(measures[measureStart + 1]?.left).toBe(272);
			expect(measures[measureStart + 1]?.width).toBe(1244);
			expect(transitions.at(-2)).toBe("none");
			expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
			expect(getPanelMaximized()).toBe(true);
			finishFlip(panel);
			expect(panel.style.left).toBe("");
			expect(panel.style.width).toBe("");

			click("restore");
			expect(transitions.at(-2)).toBe("none");
			finishFlip(panel);
			expect(panel.classList.contains("gui-pane-right--maximized")).toBe(false);
			expect(getPanelMaximized()).toBe(false);
			expect(panel.style.width).toBe(`${dockedWidth}px`);
			expect(panel.style.left).toBe("");
			expect(panel.style.top).toBe("");
			expect(panel.style.height).toBe("");
			expect(panel.style.transition).toBe("");
			expect(panel.getBoundingClientRect().width).toBe(dockedWidth);
		}
	});

	it("keeps title and accessible name synchronized through maximize and restore", () => {
		const { panel } = mountPanel();
		const button = maximizeButton(panel);
		const maximizeLabel = button.title;
		const restoreLabel = maximizeLabel === "Maximize panel" ? "Restore panel" : "还原面板";

		click("maximize");
		finishFlip(panel);
		expect(button.title).toBe(restoreLabel);
		expect(button.getAttribute("aria-label")).toBe(restoreLabel);
		expect(button.getAttribute("aria-pressed")).toBe("true");

		click("restore");
		finishFlip(panel);
		expect(button.title).toBe(maximizeLabel);
		expect(button.getAttribute("aria-label")).toBe(maximizeLabel);
		expect(button.getAttribute("aria-pressed")).toBe("false");
	});

	it("keeps maximize pointer events away from tab-drag ancestors", () => {
		const { panel } = mountPanel();
		const surface = document.querySelector<HTMLElement>(".gui-chat-surface")!;
		let captured = 0;
		surface.addEventListener("pointerdown", () => captured++);
		const button = maximizeButton(panel);
		act(() => button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
		expect(captured).toBe(0);
		// dnd ancestors can cancel the bubble phase; the native button handler must still run.
		surface.addEventListener("click", event => event.stopPropagation());
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
	});

	it("reverses a click that lands mid-morph instead of dropping it", () => {
		const { panel, dockedWidth } = mountPanel();
		const button = maximizeButton(panel);

		click("maximize");
		expect(getPanelMaximized()).toBe(true);
		// No transitionend yet: the panel is still morphing.
		click("restore");
		expect(getPanelMaximized()).toBe(false);
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(false);
		expect(button.getAttribute("aria-pressed")).toBe("false");
		finishFlip(panel);
		expect(panel.style.width).toBe(`${dockedWidth}px`);

		click("maximize");
		expect(getPanelMaximized()).toBe(true);
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
		finishFlip(panel);
		expect(button.getAttribute("aria-pressed")).toBe("true");
	});

	it("keeps state, labels and restore geometry through a tab switch while maximized", () => {
		const options: MountOptions = { tabs: [agentsTab, secondTab], activeId: agentsTab.id };
		const { panel, dockedWidth, rerender } = mountPanel(options);
		click("maximize");
		finishFlip(panel);

		rerender({ ...options, activeId: secondTab.id });
		expect(getPanelMaximized()).toBe(true);
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
		const button = maximizeButton(panel);
		expect(button.getAttribute("aria-pressed")).toBe("true");
		expect(button.getAttribute("aria-label")).toBe(button.title);

		click("restore");
		finishFlip(panel);
		expect(getPanelMaximized()).toBe(false);
		expect(panel.style.width).toBe(`${dockedWidth}px`);
		expect(maximizeButton(panel).getAttribute("aria-pressed")).toBe("false");
	});

	it("keeps the persisted width when the panel collapses and reopens while maximized", () => {
		const options: MountOptions = {};
		const { panel, dockedWidth, rerender } = mountPanel(options);
		click("maximize");
		finishFlip(panel);

		rerender({ ...options, open: false });
		expect(getPanelMaximized()).toBe(true);
		rerender({ ...options, open: true });
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
		expect(maximizeButton(panel).getAttribute("aria-pressed")).toBe("true");

		click("restore");
		finishFlip(panel);
		expect(getPanelMaximized()).toBe(false);
		expect(panel.style.width).toBe(`${dockedWidth}px`);
		expect(panel.getBoundingClientRect().width).toBe(dockedWidth);
	});

	it("applies the toggle instantly under reduced motion and stays reversible", () => {
		vi.spyOn(window, "matchMedia").mockReturnValue({
			matches: true,
			addEventListener: () => {},
			removeEventListener: () => {},
		} as unknown as MediaQueryList);
		const { panel, dockedWidth, styleValues } = mountPanel();

		click("maximize");
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
		expect(getPanelMaximized()).toBe(true);
		expect(styleValues.get("--pane-max-width")).toBe("1244px");
		expect(panel.style.transition).not.toBe("none");
		expect(maximizeButton(panel).getAttribute("aria-pressed")).toBe("true");

		click("restore");
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(false);
		expect(getPanelMaximized()).toBe(false);
		expect(panel.style.width).toBe(`${dockedWidth}px`);
		expect(panel.style.left).toBe("");
	});

	it("leaves other pane tools (new tab, split) alone", () => {
		const { panel } = mountPanel();
		let bubbled = 0;
		panel.addEventListener("click", () => bubbled++);
		const other = panel.querySelector<HTMLButtonElement>(".gui-pane-tool:not([data-panel-maximize])");
		expect(other).not.toBeNull();
		if (!other) return;
		act(() => other.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(getPanelMaximized()).toBe(false);
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(false);
		expect(bubbled).toBe(1);
	});

	it("measures the session column, never a sibling session-info dock", () => {
		const { panel, styleValues } = mountPanel({ sessionInfoDock: true });
		click("maximize");
		expect(styleValues.get("--pane-max-left")).toBe("272px");
		expect(styleValues.get("--pane-max-width")).toBe("1244px");
	});

	it("measures the welcome card when the welcome scene owns the surface", () => {
		const { panel, styleValues } = mountPanel({ welcome: true });
		click("maximize");
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
		expect(styleValues.get("--pane-max-left")).toBe("96px");
		expect(styleValues.get("--pane-max-top")).toBe("72px");
		expect(styleValues.get("--pane-max-width")).toBe("1100px");
		expect(styleValues.get("--pane-max-height")).toBe("640px");
	});

	it("ignores the outgoing scene's column during the crossfade", () => {
		const { panel, styleValues } = mountPanel({ welcome: true, leavingColumn: true });
		click("maximize");
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
		expect(styleValues.get("--pane-max-left")).toBe("96px");
		expect(styleValues.get("--pane-max-width")).toBe("1100px");
	});
});
