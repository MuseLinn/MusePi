import "./happy-dom-shim";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextPanel } from "../src/components/ContextPanel";
import type { PanelTab } from "../src/lib/panel-tabs";
import type { RpcClient } from "../src/lib/rpc";
import type { GuiSessionState } from "../src/lib/session-store";
import type { UsePanelTabsResult } from "../src/lib/use-panel-tabs";

// The single column and each split column must render their strip through the
// same header row (`.gui-pane-head`): the row owns the height, padding and
// rule, which is what keeps the tab row from changing height when split is
// toggled. These assertions lock the structure, not the pixels.

const roots: Root[] = [];
const hosts: HTMLElement[] = [];
const rpc = { request: async () => null, addEventListener: () => () => {} } as unknown as RpcClient;

const tab = (id: string, column: 0 | 1 = 0): PanelTab => ({
	id,
	surface: "agents",
	target: null,
	label: id,
	readOnly: false,
	touchedAt: 1,
	dedupeKey: null,
	dirty: false,
	preview: false,
	column,
});

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

function mountPanel(tabs: PanelTab[], split: boolean): { host: HTMLElement; ratios: number[] } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	const ratios: number[] = [];
	const panelTabs: UsePanelTabsResult = {
		tabs,
		activeId: tabs[0]?.id ?? null,
		split,
		columnActive: [tabs.find(t => t.column === 0)?.id ?? null, tabs.find(t => t.column === 1)?.id ?? null],
		splitRatio: 0.5,
		open: () => {},
		close: () => {},
		closeMany: () => {},
		duplicate: () => {},
		activate: () => {},
		reorder: () => {},
		moveToColumn: () => {},
		setSplit: () => {},
		setSplitRatio: ratio => ratios.push(ratio),
		setDirty: () => {},
	};
	act(() =>
		root.render(
			<ContextPanel
				snap={snap}
				rpc={rpc}
				open
				onViewChange={() => {}}
				panelTabs={panelTabs}
				agentId={null}
				onAgentSelect={() => {}}
			/>,
		),
	);
	return { host, ratios };
}

beforeAll(async () => {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
	GlobalRegistrator.register();
});

beforeEach(() => {
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
	while (roots.length) act(() => roots.pop()?.unmount());
	while (hosts.length) hosts.pop()?.remove();
	vi.restoreAllMocks();
});

describe("ContextPanel header row", () => {
	it("renders the single-column strip inside the shared header row", () => {
		const { host } = mountPanel([tab("agents::")], false);
		const heads = host.querySelectorAll(".gui-pane-head");
		expect(heads).toHaveLength(1);
		const head = heads[0]!;
		expect(head.querySelector(".gui-pane-head-strip .gui-surface-tabs")).not.toBeNull();
		expect(head.querySelector(".gui-pane-head-tools .gui-pane-tool")).not.toBeNull();
		// The chips box must come before the controls, never the reverse.
		const strip = head.querySelector(".gui-pane-head-strip")!;
		const tools = head.querySelector(".gui-pane-head-tools")!;
		expect(strip.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("renders one identical header row per split column", () => {
		const { host } = mountPanel([tab("agents::", 0), tab("agents::two", 1)], true);
		const heads = host.querySelectorAll(".gui-pane-head");
		expect(heads).toHaveLength(2);
		for (const head of heads) {
			expect(head.querySelector(".gui-pane-head-strip .gui-surface-tabs")).not.toBeNull();
			expect(head.querySelector(".gui-pane-head-tools .gui-pane-tool")).not.toBeNull();
		}
	});

	it("keeps the old split-only header classes out of the DOM", () => {
		const { host } = mountPanel([tab("agents::", 0), tab("agents::two", 1)], true);
		expect(host.querySelector(".gui-pane-col-head")).toBeNull();
		expect(host.querySelector(".gui-pane-col-strip")).toBeNull();
		expect(host.querySelector(".gui-pane-col-tools")).toBeNull();
	});
});

describe("ContextPanel split divider", () => {
	const divider = (host: HTMLElement): HTMLElement | null =>
		host.querySelector<HTMLElement>(".gui-pane-split-divider");

	it("sits between the two split columns and is absent while unsplit", () => {
		const split = mountPanel([tab("agents::", 0), tab("agents::two", 1)], true);
		const handle = divider(split.host)!;
		expect(handle).not.toBeNull();
		expect(handle.getAttribute("role")).toBe("separator");
		expect(handle.getAttribute("aria-orientation")).toBe("vertical");
		expect(handle.getAttribute("tabindex")).toBe("0");
		const columns = split.host.querySelectorAll(".gui-pane-col");
		expect(columns).toHaveLength(2);
		expect(columns[0]!.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(handle.compareDocumentPosition(columns[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		expect(divider(mountPanel([tab("agents::")], false).host)).toBeNull();
	});

	it("recentres on double click", () => {
		const { host, ratios } = mountPanel([tab("agents::", 0), tab("agents::two", 1)], true);
		act(() => divider(host)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(ratios).toEqual([0.5]);
	});

	it("steps the share with the arrow keys", () => {
		const { host, ratios } = mountPanel([tab("agents::", 0), tab("agents::two", 1)], true);
		const handle = divider(host)!;
		act(() => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
		// Shift is the coarse step; both start from the unchanged 0.5 prop here.
		act(() =>
			handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true })),
		);
		expect(ratios[0]).toBeCloseTo(0.52, 6);
		expect(ratios[1]).toBeCloseTo(0.4, 6);
	});
});
