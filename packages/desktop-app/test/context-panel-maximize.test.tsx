import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextPanel } from "../src/components/ContextPanel";
import { installPanelMaximizeController, setPanelMaximized } from "../src/lib/panel-maximize";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
const rpc = { request: async () => null, addEventListener: () => () => {} } as unknown as RpcClient;
const panelTabs: UsePanelTabsResult = {
	tabs: [
		{
			id: "agents::",
			surface: "agents",
			target: null,
			label: "Agents",
			readOnly: false,
			touchedAt: 1,
			dedupeKey: null,
			dirty: false,
			column: 0,
		},
	],
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

function mountPanel(): { panel: HTMLElement; dockedWidth: number; transitions: string[]; measures: DOMRect[] } {
	const surface = document.createElement("div");
	surface.className = "gui-chat-surface";
	const column = document.createElement("div");
	column.className = "gui-chat-column";
	column.getBoundingClientRect = () => rect(272, 48, 1244, 700);
	const host = document.createElement("div");
	surface.append(column, host);
	document.body.appendChild(surface);
	hosts.push(surface);
	const root = createRoot(host);
	roots.push(root);
	act(() =>
		root.render(
			<ContextPanel
				snap={snap}
				rpc={rpc}
				onViewChange={() => {}}
				panelTabs={panelTabs}
				agentId={null}
				onAgentSelect={() => {}}
			/>,
		),
	);
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
	return { panel, dockedWidth, transitions, measures };
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
			finishFlip(panel);
			expect(panel.style.left).toBe("");
			expect(panel.style.width).toBe("");

			click("restore");
			expect(transitions.at(-2)).toBe("none");
			finishFlip(panel);
			expect(panel.classList.contains("gui-pane-right--maximized")).toBe(false);
			expect(panel.style.width).toBe(`${dockedWidth}px`);
			expect(panel.style.left).toBe("");
			expect(panel.style.top).toBe("");
			expect(panel.style.height).toBe("");
			expect(panel.style.transition).toBe("");
			expect(panel.getBoundingClientRect().width).toBe(dockedWidth);
		}
	});

	it("keeps maximize pointer events away from tab-drag ancestors", () => {
		const { panel } = mountPanel();
		const surface = document.querySelector<HTMLElement>(".gui-chat-surface")!;
		let captured = 0;
		surface.addEventListener("pointerdown", () => captured++);
		const button = ["最大化面板", "Maximize panel"]
			.map(text => document.querySelector<HTMLButtonElement>(`.gui-pane-tool[aria-label="${text}"]`))
			.find(candidate => candidate !== null)!;
		act(() => button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
		expect(captured).toBe(0);
		// dnd ancestors can cancel the bubble phase; the native button handler must still run.
		surface.addEventListener("click", event => event.stopPropagation());
		act(() => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(panel.classList.contains("gui-pane-right--maximized")).toBe(true);
	});
});
