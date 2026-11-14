import { describe, expect, it } from "bun:test";
import { browserPanelDescriptor, browserTarget, reconcileBrowserPanelTabs } from "../src/lib/browser-panel-tabs";
import type { ManagedTab } from "../src/lib/managed-browser-host";
import { EMPTY_PANEL_TAB_STATE, type PanelTab, type PanelTabState, panelTabId } from "../src/lib/panel-tabs";

function managedTab(id: string, overrides?: Partial<ManagedTab>): ManagedTab {
	return {
		id,
		url: `https://${id}.example`,
		title: `Title ${id}`,
		customTitle: null,
		muted: false,
		loading: false,
		blank: false,
		agent: false,
		favicon: null,
		themeColor: null,
		canGoBack: false,
		canGoForward: false,
		lastActivityAt: 1,
		frozen: false,
		...overrides,
	};
}

function panelTab(surface: string, target: string | null, column: 0 | 1 = 0): PanelTab {
	return {
		id: panelTabId({ surface, target, dedupeKey: surface === "browser" ? target : null }),
		surface,
		target,
		label: target ?? surface,
		readOnly: false,
		touchedAt: 1,
		dedupeKey: surface === "browser" ? target : null,
		dirty: false,
		preview: false,
		column,
	};
}

describe("browserPanelDescriptor", () => {
	it("uses the managed id for identity and the localized label for blank pages", () => {
		const tab = managedTab("tab-1", {
			url: "about:blank",
			title: "about:blank",
			blank: true,
		});

		expect(browserPanelDescriptor(tab, "新标签页")).toEqual({
			surface: "browser",
			target: "tab-1",
			dedupeKey: "tab-1",
			label: "新标签页",
		});
	});

	it("uses the page title without requiring a favicon", () => {
		expect(browserPanelDescriptor(managedTab("tab-2", { title: "Example" }), "Browser").label).toBe("Example");
	});

	it("prefers a user rename over later page-title updates", () => {
		const tab = managedTab("tab-renamed", { title: "Later title", customTitle: "Research" });
		expect(browserPanelDescriptor(tab, "Browser").label).toBe("Research");
	});
});

describe("browserTarget", () => {
	it("resolves only current browser panel tabs to managed ids", () => {
		expect(browserTarget(panelTab("browser", "tab-3"))).toBe("tab-3");
		expect(browserTarget(panelTab("files", "/a.md"))).toBeNull();
		expect(browserTarget(panelTab("settings.browser", "tab-3"))).toBeNull();
	});
});

describe("reconcileBrowserPanelTabs", () => {
	it("adds host-created tabs and removes host-deleted tabs without stealing panel focus", () => {
		const file = panelTab("files", "/a.md");
		const stale = panelTab("browser", "stale");
		const state: PanelTabState = {
			tabs: [file, stale],
			activeId: file.id,
			split: false,
			columnActive: [file.id, null],
		};

		const next = reconcileBrowserPanelTabs(state, [managedTab("created")], "Browser");

		expect(next.tabs.map(tab => tab.id)).toEqual(["files::/a.md", "browser::created"]);
		expect(next.tabs[0]).toBe(file);
		expect(next.activeId).toBe("files::/a.md");
		expect(next.columnActive).toEqual(["files::/a.md", null]);
	});

	it("removes a panel-deleted guest after the host drops it and repairs active ids", () => {
		const first = panelTab("browser", "first");
		const deleted = panelTab("browser", "deleted");
		const state: PanelTabState = {
			tabs: [first, deleted],
			activeId: deleted.id,
			split: false,
			columnActive: [deleted.id, null],
		};

		const next = reconcileBrowserPanelTabs(state, [managedTab("first")], "Browser");

		expect(next.tabs.map(tab => tab.id)).toEqual(["browser::first"]);
		expect(next.activeId).toBe("browser::first");
		expect(next.columnActive).toEqual(["browser::first", null]);
	});

	it("updates titles independently of favicons and keeps unchanged tab references", () => {
		const file = panelTab("files", "/a.md");
		const browser = panelTab("browser", "tab-4");
		const state: PanelTabState = {
			tabs: [file, browser],
			activeId: file.id,
			split: false,
			columnActive: [file.id, null],
		};
		const hostTabs = [managedTab("tab-4", { title: "Updated title", favicon: null })];

		const next = reconcileBrowserPanelTabs(state, hostTabs, "Browser");

		expect(next.tabs[1]?.label).toBe("Updated title");
		expect(next.tabs[0]).toBe(file);
		expect(next.tabs[1]?.touchedAt).toBe(browser.touchedAt);
	});

	it("returns the original state for an idempotent projection", () => {
		const hostTabs = [managedTab("tab-5")];
		const projected = reconcileBrowserPanelTabs(EMPTY_PANEL_TAB_STATE, hostTabs, "Browser");

		expect(reconcileBrowserPanelTabs(projected, hostTabs, "Browser")).toBe(projected);
	});

	it("preserves split columns and active displays while projecting host changes", () => {
		const file = panelTab("files", "/a.md");
		const browser = panelTab("browser", "right", 1);
		const state: PanelTabState = {
			tabs: [file, browser],
			activeId: browser.id,
			split: true,
			columnActive: [file.id, browser.id],
		};

		const next = reconcileBrowserPanelTabs(state, [managedTab("right"), managedTab("created")], "Browser");

		expect(next.tabs.map(tab => [tab.id, tab.column])).toEqual([
			["files::/a.md", 0],
			["browser::right", 1],
			["browser::created", 1],
		]);
		expect(next.activeId).toBe("browser::right");
		expect(next.columnActive).toEqual(["files::/a.md", "browser::right"]);
	});

	it("keeps all 13 host projections without panel-budget eviction or display churn", () => {
		const hostTabs = Array.from({ length: 13 }, (_, index) =>
			managedTab(`tab-${index}`, { lastActivityAt: index + 1 }),
		);
		const first = panelTab("browser", "tab-0");
		const displayedRight = { ...panelTab("browser", "tab-1", 1), touchedAt: 0 };
		const remainingLeft = Array.from({ length: 10 }, (_, index) => panelTab("browser", `tab-${index + 2}`));
		const state: PanelTabState = {
			tabs: [first, ...remainingLeft, displayedRight],
			activeId: first.id,
			split: true,
			columnActive: [first.id, displayedRight.id],
		};

		const next = reconcileBrowserPanelTabs(state, hostTabs, "Browser");

		expect(next.tabs).toHaveLength(13);
		expect(next.columnActive).toEqual([first.id, displayedRight.id]);
		expect(next.tabs.some(tab => tab.id === next.columnActive[1])).toBe(true);
		expect(reconcileBrowserPanelTabs(next, hostTabs, "Browser")).toBe(next);
	});

	it("inserts a host-created tab at the end of its target column", () => {
		const left = panelTab("browser", "left");
		const right = panelTab("browser", "right", 1);
		const state: PanelTabState = {
			tabs: [left, right],
			activeId: left.id,
			split: true,
			columnActive: [left.id, right.id],
		};

		const next = reconcileBrowserPanelTabs(
			state,
			[managedTab("left"), managedTab("right"), managedTab("created")],
			"Browser",
		);

		expect(next.tabs.map(tab => [tab.id, tab.column])).toEqual([
			["browser::left", 0],
			["browser::created", 0],
			["browser::right", 1],
		]);
	});

	it("shows the cross-column right neighbour activated by a host deletion", () => {
		const left = panelTab("browser", "left");
		const deleted = panelTab("browser", "deleted");
		const right = panelTab("browser", "right", 1);
		const previouslyDisplayed = panelTab("browser", "previously-displayed", 1);
		const state: PanelTabState = {
			tabs: [left, deleted, right, previouslyDisplayed],
			activeId: deleted.id,
			split: true,
			columnActive: [deleted.id, previouslyDisplayed.id],
		};

		const next = reconcileBrowserPanelTabs(
			state,
			[managedTab("left"), managedTab("right"), managedTab("previously-displayed")],
			"Browser",
		);

		expect(next.activeId).toBe(right.id);
		expect(next.columnActive).toEqual([left.id, right.id]);
	});
});
