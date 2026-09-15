import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	closeSurfaceTab,
	reorderSurfaceTabs,
	restoreSurfaceTabs,
	type SurfaceTab,
	SurfaceTabPanels,
	type SurfaceTabState,
	SurfaceTabStrip,
	serializeSurfaceTabs,
} from "../src/components/surface-tabs";

// Surface-scoped multi-instance tab strip contracts. The rail stays the
// single navigation axis (architectural veto on a panel-header tab row);
// these tabs switch instances *within* one surface, so the invariants that
// matter are: stable ids (never index), adjacent-activation on close,
// label-only serialization, and keep-mounted-by-default panel rendering.

const tab = (id: string, title = id): SurfaceTab => ({ id, title });
const state = (tabs: SurfaceTab[], activeId: string | null = null): SurfaceTabState => ({ tabs, activeId });

describe("reorderSurfaceTabs", () => {
	const base = [tab("a"), tab("b"), tab("c")];

	it("moves a tab and keeps the others in order", () => {
		expect(reorderSurfaceTabs(base, "a", "c").map(t => t.id)).toEqual(["b", "c", "a"]);
	});

	it("is reference-stable when either id is unknown", () => {
		expect(reorderSurfaceTabs(base, "x", "b")).toBe(base);
		expect(reorderSurfaceTabs(base, "a", "x")).toBe(base);
	});

	it("is reference-stable when from === to", () => {
		expect(reorderSurfaceTabs(base, "b", "b")).toBe(base);
	});
});

describe("closeSurfaceTab", () => {
	const base = state([tab("a"), tab("b"), tab("c")], "b");

	it("activates the right neighbour first", () => {
		expect(closeSurfaceTab(base, "b")).toEqual({ tabs: [tab("a"), tab("c")], activeId: "c" });
	});

	it("falls back to the left neighbour at the tail", () => {
		const s = state([tab("a"), tab("b")], "b");
		expect(closeSurfaceTab(s, "b")).toEqual({ tabs: [tab("a")], activeId: "a" });
	});

	it("clears activeId when the last tab closes", () => {
		const s = state([tab("a")], "a");
		expect(closeSurfaceTab(s, "a")).toEqual({ tabs: [], activeId: null });
	});

	it("keeps activeId when closing an inactive tab", () => {
		expect(closeSurfaceTab(base, "a")).toEqual({ tabs: [tab("b"), tab("c")], activeId: "b" });
	});

	it("is reference-stable for an unknown id", () => {
		expect(closeSurfaceTab(base, "x")).toBe(base);
	});
});

describe("serializeSurfaceTabs / restoreSurfaceTabs", () => {
	it("round-trips order and activeId, dropping runtime-only dirty flags", () => {
		const s = state([{ id: "a", title: "A", dirty: true }, tab("b")], "a");
		const back = restoreSurfaceTabs(JSON.parse(JSON.stringify(serializeSurfaceTabs(s))));
		expect(back).toEqual({ tabs: [tab("a", "A"), tab("b")], activeId: "a" });
	});

	it("rejects an unknown schema version instead of best-effort migrating", () => {
		expect(restoreSurfaceTabs({ v: 999, tabs: [], activeId: null })).toEqual({ tabs: [], activeId: null });
	});

	it("rejects malformed input", () => {
		expect(restoreSurfaceTabs(null)).toEqual({ tabs: [], activeId: null });
		expect(restoreSurfaceTabs("nope")).toEqual({ tabs: [], activeId: null });
	});

	it("drops entries with unknown ids and fixes a dangling activeId", () => {
		const raw = { v: 1, tabs: [{ id: "a", title: "A" }, { title: "no id" }], activeId: "ghost" };
		expect(restoreSurfaceTabs(raw)).toEqual({ tabs: [tab("a", "A")], activeId: "a" });
	});
});

describe("SurfaceTabStrip markup", () => {
	const tabs = [tab("a", "A"), { id: "b", title: "B", dirty: true }];

	it("renders a horizontal tablist with aria-selected and roving tabindex", () => {
		const html = renderToStaticMarkup(
			<SurfaceTabStrip tabs={tabs} activeId="b" onActivate={() => {}} onClose={() => {}} onReorder={() => {}} />,
		);
		expect(html).toContain('role="tablist"');
		expect(html).toContain('aria-orientation="horizontal"');
		// dnd-kit injects role="button" on sortable items; tab semantics must win.
		expect(html.match(/role="tab"/g)?.length).toBe(2);
		// Roving tabindex: exactly one tab in the tab order, the active one.
		expect(html.match(/tabindex="0"/g)?.length).toBe(1);
		expect(html.match(/tabindex="-1"/g)?.length).toBe(1);
		expect(html).toContain('aria-selected="true"');
		expect(html).toContain('aria-selected="false"');
	});

	it("labels close buttons per tab so screen readers can tell them apart", () => {
		const html = renderToStaticMarkup(
			<SurfaceTabStrip
				tabs={tabs}
				activeId="a"
				closeLabel="Close"
				onActivate={() => {}}
				onClose={() => {}}
				onReorder={() => {}}
			/>,
		);
		expect(html).toContain("Close B");
		expect(html).toContain("Close A");
	});

	it("renders the dirty marker only for dirty tabs", () => {
		const html = renderToStaticMarkup(
			<SurfaceTabStrip tabs={tabs} activeId="a" onActivate={() => {}} onClose={() => {}} onReorder={() => {}} />,
		);
		expect(html).toContain("gui-surface-tab-dirty");
		expect(html.match(/gui-surface-tab-dirty/g)?.length).toBe(1);
	});
});

describe("SurfaceTabPanels", () => {
	const tabs = [tab("a"), tab("b")];

	it("keeps inactive panels mounted by default (display:none, not unmounted)", () => {
		const seen: string[] = [];
		renderToStaticMarkup(
			<SurfaceTabPanels
				tabs={tabs}
				activeId="a"
				render={t => {
					seen.push(t.id);
					return <p>{t.id}</p>;
				}}
			/>,
		);
		expect(seen).toEqual(["a", "b"]);
	});

	it("unmounts only the ids listed in unmountIds", () => {
		const seen: string[] = [];
		renderToStaticMarkup(
			<SurfaceTabPanels
				tabs={tabs}
				activeId="a"
				unmountIds={new Set(["b"])}
				render={t => {
					seen.push(t.id);
					return <p>{t.id}</p>;
				}}
			/>,
		);
		expect(seen).toEqual(["a"]);
	});
});
