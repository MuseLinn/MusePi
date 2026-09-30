import { describe, expect, it } from "bun:test";
import {
	activatePanelTab,
	closePanelTab,
	closePanelTabs,
	EMPTY_PANEL_TAB_STATE,
	movePanelTabToColumn,
	type PanelColumn,
	type PanelTab,
	type PanelTabDescriptor,
	type PanelTabState,
	panelTabId,
	reorderPanelTabs,
	restorePanelTabs,
	serializePanelTabs,
	setPanelSplit,
	setPanelTabDirty,
	tabsInColumn,
	upsertPanelTab,
} from "../src/lib/panel-tabs";

// Panel-level heterogeneous tab model (openchamber ContextPanel parity): one
// strip hosts every surface's instances, the rail launches tabs. The
// invariants under test are identity/dedupe, placeholder replacement,
// background (reveal:false) registration, the per-surface eviction budget,
// and label-only persistence.

const desc = (surface: string, target?: string | null, extra?: Partial<PanelTabDescriptor>): PanelTabDescriptor => ({
	surface,
	target: target ?? null,
	...extra,
});

const state = (tabs: PanelTab[], activeId: string | null = null): PanelTabState => ({
	tabs,
	activeId,
	split: false,
	columnActive: [activeId, null],
});
const ids = (s: PanelTabState): string[] => s.tabs.map(t => t.id);

describe("panelTabId", () => {
	it("prefers the dedupe key, then surface+target, then the surface placeholder", () => {
		expect(panelTabId(desc("chat", undefined, { dedupeKey: "sess-1" }))).toBe("chat::sess-1");
		expect(panelTabId(desc("files", "/a.md"))).toBe("files::/a.md");
		expect(panelTabId(desc("files"))).toBe("files::");
	});
});

describe("upsertPanelTab", () => {
	it("appends and activates by default", () => {
		const s = upsertPanelTab(state([]), desc("files", "/a.md", { label: "a.md" }));
		expect(ids(s)).toEqual(["files::/a.md"]);
		expect(s.activeId).toBe("files::/a.md");
	});

	it("dedupes by id: re-opening updates label/touch instead of duplicating", () => {
		const first = upsertPanelTab(state([]), desc("files", "/a.md", { label: "a.md" }), { now: 1 });
		const second = upsertPanelTab(first, desc("files", "/a.md", { label: "A.md" }), { now: 2 });
		expect(ids(second)).toEqual(["files::/a.md"]);
		expect(second.tabs[0]?.label).toBe("A.md");
		expect(second.tabs[0]?.touchedAt).toBe(2);
	});

	it("replaces the surface's placeholder when a real instance opens", () => {
		const withPlaceholder = upsertPanelTab(state([]), desc("browser"));
		expect(ids(withPlaceholder)).toEqual(["browser::"]);
		const opened = upsertPanelTab(withPlaceholder, desc("browser", "https://x.dev"));
		expect(ids(opened)).toEqual(["browser::https://x.dev"]);
	});

	it("keeps the files placeholder as its own tab when a file opens (dsh tree parity)", () => {
		// The files placeholder IS the tree browser: a real file instance opens
		// NEXT to it so the tree stays one click away instead of being consumed.
		const withPlaceholder = upsertPanelTab(state([]), desc("files"));
		expect(ids(withPlaceholder)).toEqual(["files::"]);
		const opened = upsertPanelTab(withPlaceholder, desc("files", "/a.md"));
		expect(ids(opened)).toEqual(["files::", "files::/a.md"]);
		expect(opened.activeId).toBe("files::/a.md");
	});

	it("keeps placeholders of other surfaces intact", () => {
		const s = upsertPanelTab(state([]), desc("files"), { now: 1 });
		const s2 = upsertPanelTab(s, desc("notes", "note-1"), { now: 2 });
		expect(ids(s2)).toEqual(["files::", "notes::note-1"]);
	});

	it("reveal:false registers in the background without stealing focus", () => {
		const viewing = upsertPanelTab(state([]), desc("files", "/a.md"), { now: 1 });
		const s = upsertPanelTab(viewing, desc("browser", "https://x.dev", { label: "x.dev" }), {
			reveal: false,
			now: 2,
		});
		expect(s.activeId).toBe("files::/a.md");
		expect(ids(s)).toEqual(["files::/a.md", "browser::https://x.dev"]);
	});

	it("reveal:false still seeds an active tab when none was open", () => {
		const s = upsertPanelTab(state([]), desc("files", "/a.md"), { reveal: false, now: 1 });
		expect(s.activeId).toBe("files::/a.md");
	});
});

describe("per-surface eviction budget", () => {
	it("evicts the oldest non-active tab of the over-budget surface only", () => {
		let s = state([]);
		for (let i = 0; i < 13; i++) {
			s = upsertPanelTab(s, desc("files", `/f${i}.md`), { now: i + 1 });
		}
		// 13 opens, budget 12 → /f0.md (oldest, inactive) is spent.
		expect(s.tabs.length).toBe(12);
		expect(ids(s)).not.toContain("files::/f0.md");
		// Another surface's tabs are untouched by the files budget.
		const mixed = upsertPanelTab(s, desc("notes", "n1"), { now: 99 });
		expect(mixed.tabs.filter(t => t.surface === "notes").length).toBe(1);
	});

	it("never evicts the active tab, keeping one over budget instead", () => {
		let s = state([]);
		for (let i = 0; i < 12; i++) s = upsertPanelTab(s, desc("files", `/f${i}.md`), { now: i + 1 });
		// Re-touch the oldest (now:1) as background noise, then reopen f0 so it
		// becomes active while remaining the oldest touched.
		s = upsertPanelTab(s, desc("files", "/f1.md"), { now: 100, reveal: false });
		s = upsertPanelTab(s, desc("files", "/f0.md"), { now: 101 });
		const f0 = s.tabs.find(t => t.id === "files::/f0.md");
		expect(f0?.touchedAt).toBe(101);
		expect(s.tabs.some(t => t.id === "files::/f0.md")).toBe(true);
	});
});

describe("closePanelTab / closePanelTabs", () => {
	const base = state(
		[desc("files", "/a.md"), desc("files", "/b.md"), desc("notes", "n1")].map(d => ({
			id: panelTabId(d),
			surface: d.surface,
			target: d.target ?? null,
			label: d.target ?? d.surface,
			readOnly: false,
			touchedAt: 1,
			dedupeKey: null,
			dirty: false,
			column: 0 as PanelColumn,
		})),
		"files::/b.md",
	);

	it("activates the right neighbour first", () => {
		const s = closePanelTab(base, "files::/b.md");
		expect(s.activeId).toBe("notes::n1");
	});

	it("falls back to the left neighbour at the tail", () => {
		const s = closePanelTab(base, "notes::n1");
		expect(s.activeId).toBe("files::/b.md");
	});

	it("clears activeId when the last tab closes", () => {
		const s = closePanelTab(state([base.tabs[0]!], "files::/a.md"), "files::/a.md");
		expect(s).toEqual({ tabs: [], activeId: null, split: false, columnActive: [null, null] });
	});

	it("is reference-stable for an unknown id", () => {
		expect(closePanelTab(base, "files::/ghost.md")).toBe(base);
	});

	it("closes a batch without resetting the active tab on misses", () => {
		const s = closePanelTabs(base, ["files::/ghost.md", "files::/a.md"]);
		expect(ids(s)).toEqual(["files::/b.md", "notes::n1"]);
		expect(s.activeId).toBe("files::/b.md");
	});
});

describe("serializePanelTabs / restorePanelTabs", () => {
	it("round-trips and re-derives ids, preserving dedupe keys", () => {
		const s = upsertPanelTab(state([]), desc("chat", undefined, { dedupeKey: "sess-9", label: "session 9" }), {
			now: 1,
		});
		const back = restorePanelTabs(JSON.parse(JSON.stringify(serializePanelTabs(s))));
		expect(back).toEqual(s);
	});

	it("rejects an unknown schema version and malformed rows", () => {
		expect(restorePanelTabs({ v: 999, tabs: [], activeId: null })).toEqual(EMPTY_PANEL_TAB_STATE);
		expect(restorePanelTabs(null)).toEqual(EMPTY_PANEL_TAB_STATE);
		const raw = {
			v: 1,
			tabs: [{ surface: "files", target: "/a.md", label: "a" }, { target: "/no-surface" }],
			activeId: null,
		};
		expect(restorePanelTabs(raw).tabs.length).toBe(1);
	});

	it("repairs a dangling activeId by falling back to the newest tab", () => {
		const raw = {
			v: 1,
			tabs: [{ surface: "files", target: "/a.md", label: "a", readOnly: false, touchedAt: 1, dedupeKey: null }],
			activeId: "files::/ghost.md",
		};
		expect(restorePanelTabs(raw).activeId).toBe("files::/a.md");
	});
});

describe("setPanelTabDirty", () => {
	// The unsaved-content dot drives the close guard: the strip must reflect
	// the editor's buffer exactly, and a no-op report must not churn the tab
	// array (the editor reports on every parent render).
	it("marks the tab and is reference-stable on a repeated identical report", () => {
		const s = upsertPanelTab(state([], null), desc("files", "/a.md"));
		const marked = setPanelTabDirty(s, "files::/a.md", true);
		expect(marked.tabs[0]!.dirty).toBe(true);
		expect(setPanelTabDirty(marked, "files::/a.md", true)).toBe(marked);
		expect(setPanelTabDirty(marked, "files::/a.md", false).tabs[0]!.dirty).toBe(false);
	});

	it("leaves other tabs and an unknown id untouched", () => {
		const s = upsertPanelTab(upsertPanelTab(state([], null), desc("files", "/a.md")), desc("files", "/b.md"));
		const marked = setPanelTabDirty(s, "files::/a.md", true);
		expect(marked.tabs.find(t => t.id === "files::/b.md")!.dirty).toBe(false);
		expect(setPanelTabDirty(s, "files::/ghost.md", true)).toBe(s);
	});

	it("never persists dirty — a restored layout starts clean", () => {
		const s = setPanelTabDirty(upsertPanelTab(state([], null), desc("files", "/a.md")), "files::/a.md", true);
		const restored = restorePanelTabs(serializePanelTabs(s));
		expect(restored.tabs[0]!.dirty).toBe(false);
	});
});

describe("split columns (dsh 0.2.0 two-column parity)", () => {
	const splitBase = (): PanelTabState => {
		// Two tabs in column 0, one in column 1 — flat array stays grouped.
		let s = state([], null);
		s = upsertPanelTab(s, desc("files", "/a.md"), { now: 1 });
		s = upsertPanelTab(s, desc("files", "/b.md"), { now: 2 });
		s = upsertPanelTab(s, desc("notes", "n1"), { now: 3, column: 1 });
		return { ...s, split: true, columnActive: ["files::/b.md", "notes::n1"] };
	};

	it("setPanelSplit(true) never moves tabs — column 1 starts empty", () => {
		const s = upsertPanelTab(state([], null), desc("files", "/a.md"));
		const on = setPanelSplit(s, true);
		expect(on.split).toBe(true);
		expect(ids(on)).toEqual(ids(s));
		expect(on.columnActive).toEqual(s.columnActive);
	});

	it("setPanelSplit(false) merges column 1 back into column 0 preserving order", () => {
		const s = splitBase();
		const off = setPanelSplit(s, false);
		expect(off.split).toBe(false);
		expect(off.tabs.every(t => t.column === 0)).toBe(true);
		expect(ids(off)).toEqual(["files::/a.md", "files::/b.md", "notes::n1"]);
		// The globally focused tab (notes, from column 1) stays the single display.
		expect(off.columnActive).toEqual(["notes::n1", null]);
	});

	it("movePanelTabToColumn keeps the flat array column-grouped and focuses the moved tab", () => {
		const s = splitBase();
		const moved = movePanelTabToColumn(s, "files::/a.md", 1);
		// Joins the END of the target column's slice (grouped flat array).
		expect(ids(moved)).toEqual(["files::/b.md", "notes::n1", "files::/a.md"]);
		expect(moved.tabs[2]!.column).toBe(1);
		expect(moved.columnActive[1]).toBe("files::/a.md");
		expect(moved.activeId).toBe("files::/a.md");
		// The vacated column 0 display falls back to its own neighbour.
		expect(moved.columnActive[0]).toBe("files::/b.md");
	});

	it("movePanelTabToColumn is reference-stable for unknown ids and same-column moves", () => {
		const s = splitBase();
		expect(movePanelTabToColumn(s, "files::/ghost.md", 1)).toBe(s);
		expect(movePanelTabToColumn(s, "notes::n1", 1)).toBe(s);
	});

	it("tabsInColumn slices honour the flat-array grouping invariant", () => {
		const s = splitBase();
		expect(tabsInColumn(s.tabs, 0).map(t => t.id)).toEqual(["files::/a.md", "files::/b.md"]);
		expect(tabsInColumn(s.tabs, 1).map(t => t.id)).toEqual(["notes::n1"]);
	});

	it("reorderPanelTabs is a cross-column no-op (the caller routes those to movePanelTabToColumn)", () => {
		const s = splitBase();
		expect(reorderPanelTabs(s.tabs, "files::/a.md", "notes::n1")).toBe(s.tabs);
		// Same-column pairs still reorder.
		const reordered = reorderPanelTabs(s.tabs, "files::/a.md", "files::/b.md");
		expect(ids({ ...s, tabs: reordered })).toEqual(["files::/b.md", "files::/a.md", "notes::n1"]);
	});

	it("activatePanelTab updates only the tab's own column display", () => {
		const s = splitBase();
		const withA = activatePanelTab(s, "files::/a.md");
		expect(withA.activeId).toBe("files::/a.md");
		expect(withA.columnActive).toEqual(["files::/a.md", "notes::n1"]);
		const withN = activatePanelTab(withA, "notes::n1");
		expect(withN.columnActive).toEqual(["files::/a.md", "notes::n1"]);
	});

	it("restores a v1 (pre-split) payload by migrating every tab into column 0", () => {
		const raw = {
			v: 1,
			tabs: [
				{ surface: "files", target: "/a.md", label: "a", readOnly: false, touchedAt: 1, dedupeKey: null },
				{ surface: "notes", target: "n1", label: "n", readOnly: false, touchedAt: 2, dedupeKey: null },
			],
			activeId: "files::/a.md",
		};
		const restored = restorePanelTabs(raw);
		expect(restored.split).toBe(false);
		expect(restored.tabs.every(t => t.column === 0)).toBe(true);
		expect(restored.activeId).toBe("files::/a.md");
		expect(restored.columnActive).toEqual(["files::/a.md", null]);
	});

	it("round-trips a split layout with per-column displays intact", () => {
		const s = splitBase();
		const back = restorePanelTabs(JSON.parse(JSON.stringify(serializePanelTabs(s))));
		expect(back).toEqual(s);
	});
});
