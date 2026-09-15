import { describe, expect, it } from "bun:test";
import {
	clampPanelTabs,
	closePanelTab,
	closePanelTabs,
	type PanelTab,
	type PanelTabDescriptor,
	type PanelTabState,
	panelTabId,
	restorePanelTabs,
	serializePanelTabs,
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

const state = (tabs: PanelTab[], activeId: string | null = null): PanelTabState => ({ tabs, activeId });
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
		const withPlaceholder = upsertPanelTab(state([]), desc("files"));
		expect(ids(withPlaceholder)).toEqual(["files::"]);
		const opened = upsertPanelTab(withPlaceholder, desc("files", "/a.md"));
		expect(ids(opened)).toEqual(["files::/a.md"]);
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
		expect(s).toEqual({ tabs: [], activeId: null });
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
		expect(restorePanelTabs({ v: 999, tabs: [], activeId: null })).toEqual({ tabs: [], activeId: null });
		expect(restorePanelTabs(null)).toEqual({ tabs: [], activeId: null });
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
