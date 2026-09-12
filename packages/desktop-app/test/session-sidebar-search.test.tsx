import "./dom-shim"; // MUST be first: GUI components touch guest-client element classes / the icon sprite at import time.
import { describe, expect, test } from "bun:test";
import { t } from "@musepi/guest-client";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GroupedSessionList } from "../src/components/GroupedSessionList";
import { SessionList, type SessionListNode } from "../src/components/SessionList";
import { SessionSearchBar } from "../src/components/SessionSearchBar";
import { SessionSidebar } from "../src/components/SessionSidebar";
import { filterSessionTree, isRecentlyActive } from "../src/components/session-list-shared";

/**
 * Sidebar session panel contracts (search + 近期 projection):
 * - the search box reports the sessions a query kept, marks the matched
 *   fragments in row titles, and states an empty result instead of letting a
 *   section's "no sessions yet" fallback read as an empty workspace;
 * - 近期 projects only sessions with activity inside the 48h retention window
 *   (or a live turn / unread mark), without removing them from their groups.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.now();
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function node(id: string, label: string, updatedAt: string, parentId: string | null = null): SessionListNode {
	return {
		entry: { type: "session", id, parentId, timestamp: updatedAt, updatedAt, label },
		children: [],
	};
}

type Meta = {
	cwd?: string;
	model?: string;
	paused?: boolean;
	working?: boolean;
	status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
};

/** Full sidebar render (groups tab by default) — the search box, the sections
 *  and the 近期 projection all live here. */
function sidebarHtml(options: {
	nodes: SessionListNode[];
	sessionMeta?: Map<string, Meta>;
	unread?: ReadonlySet<string>;
}): string {
	return renderToStaticMarkup(
		<SessionSidebar
			nodes={options.nodes}
			sessionMeta={options.sessionMeta ?? new Map<string, Meta>()}
			selectedId={null}
			onSelect={() => {}}
			onNewSession={() => {}}
			status="open"
			onDisconnect={() => {}}
			onOpenConnect={() => {}}
			onOpenSettings={() => {}}
			onOpenSearch={() => {}}
			onOpenSkills={() => {}}
			collapsed={false}
			onDeleteArchived={async () => true}
			unread={options.unread}
		/>,
	);
}

function barHtml(overrides: { open?: boolean; query?: string; matchCount?: number } = {}): string {
	return renderToStaticMarkup(
		<SessionSearchBar
			open={overrides.open ?? true}
			query={overrides.query ?? ""}
			matchCount={overrides.matchCount ?? 0}
			inputRef={createRef<HTMLInputElement>()}
			onQueryChange={() => {}}
			onOpenChange={() => {}}
		/>,
	);
}

function listHtml(searchQuery?: string): string {
	return renderToStaticMarkup(
		<SessionList
			nodes={[node("n1", "DeepSeek 重构", ago(HOUR))]}
			selectedId={null}
			onSelect={() => {}}
			searchQuery={searchQuery}
		/>,
	);
}

describe("近期 projection", () => {
	test("lists only sessions active inside the 48h window, plus live/unread ones", () => {
		const html = sidebarHtml({
			nodes: [
				node("fresh", "Fresh task", ago(1 * HOUR)),
				node("working", "Working old task", ago(5 * 24 * HOUR)),
				node("unread", "Unread old task", ago(5 * 24 * HOUR)),
				node("stale", "Stale task", ago(5 * 24 * HOUR)),
			],
			sessionMeta: new Map([["working", { working: true }]]),
			unread: new Set(["unread"]),
		});
		const start = html.indexOf(t("recent"));
		expect(start).toBeGreaterThanOrEqual(0);
		// The next block owns the list (empty custom groups → the 新建分组 button).
		const end = html.indexOf(t("new group"), start);
		expect(end).toBeGreaterThan(start);
		const recentBlock = html.slice(start, end);
		expect(recentBlock).toContain("Fresh task");
		expect(recentBlock).toContain("Working old task");
		expect(recentBlock).toContain("Unread old task");
		expect(recentBlock).not.toContain("Stale task");
	});

	test("keeps its members in their date groups (projection, not a move)", () => {
		const html = sidebarHtml({ nodes: [node("fresh", "Fresh task", ago(1 * HOUR))] });
		const occurrences = html.split("Fresh task").length - 1;
		expect(occurrences).toBeGreaterThan(1);
	});

	test("stays hidden when nothing is recent", () => {
		const html = sidebarHtml({ nodes: [node("stale", "Stale task", ago(5 * 24 * HOUR))] });
		expect(html).not.toContain(t("recent"));
		expect(html).toContain("Stale task");
	});
});

describe("isRecentlyActive", () => {
	test("treats a running or unread session as recent regardless of age", () => {
		const old = { updatedAt: ago(5 * 24 * HOUR) };
		expect(isRecentlyActive(old, { working: true })).toBe(true);
		expect(isRecentlyActive(old, { unread: true })).toBe(true);
		expect(isRecentlyActive(old)).toBe(false);
	});

	test("keeps activity inside the window and drops what ages out", () => {
		expect(isRecentlyActive({ updatedAt: ago(47 * HOUR) })).toBe(true);
		expect(isRecentlyActive({ updatedAt: ago(49 * HOUR) })).toBe(false);
	});

	test("falls back to the creation timestamp and ignores unparseable values", () => {
		expect(isRecentlyActive({ timestamp: ago(2 * HOUR) })).toBe(true);
		expect(isRecentlyActive({})).toBe(false);
		expect(isRecentlyActive({ timestamp: "not-a-date" })).toBe(false);
	});
});

describe("filterSessionTree", () => {
	test("counts what it keeps and prunes branches that cannot match", () => {
		const roots = [node("a", "DeepSeek refactor", ago(HOUR)), node("b", "Unrelated note", ago(HOUR))];
		const result = filterSessionTree(roots, "deep", n => n.entry.label ?? "");
		expect(result.matched).toBe(1);
		expect(result.nodes.map(n => n.entry.id)).toEqual(["a"]);
	});

	test("keeps a matched ancestor as a container without counting it", () => {
		const parent = {
			...node("p", "Parent task", ago(3 * HOUR)),
			children: [node("c", "Child deep dive", ago(HOUR))],
		};
		const result = filterSessionTree([parent], "deep", n => n.entry.label ?? "");
		expect(result.matched).toBe(1);
		expect(result.nodes.map(n => n.entry.id)).toEqual(["p"]);
		expect(result.nodes[0]!.children.map(n => n.entry.id)).toEqual(["c"]);
	});

	test("returns the list untouched for an empty query", () => {
		const roots = [node("a", "Anything", ago(HOUR))];
		const result = filterSessionTree(roots, "   ", () => "");
		expect(result.matched).toBe(0);
		expect(result.nodes).toBe(roots);
	});
});

describe("session search box", () => {
	test("reports the match count and the Escape affordance", () => {
		const html = barHtml({ query: "deep", matchCount: 3 });
		expect(html).toContain(t("search match count", { count: 3 }));
		expect(html).toContain(t("esc to clear or close"));
		expect(html).toContain('value="deep"');
		expect(html).toContain(t("clear"));
	});

	test("renders the empty state when the query matches nothing", () => {
		const html = barHtml({ query: "zzz", matchCount: 0 });
		expect(html).toContain(t("no matching sessions"));
		expect(html).not.toContain(t("search match count", { count: 0 }));
	});

	test("shows neither a count nor the empty state without a query", () => {
		const html = barHtml({ query: "", matchCount: 0 });
		expect(html).toContain("<input");
		expect(html).not.toContain(t("no matching sessions"));
		expect(html).not.toContain(t("search match count", { count: 0 }));
	});

	test("stays out of the tree while closed", () => {
		expect(barHtml({ open: false })).toBe("");
	});
});

describe("row title highlight", () => {
	test("marks the matched fragment and keeps the rest of the title", () => {
		const html = listHtml("deep");
		expect(html).toContain(">Deep</mark>");
		expect(html).toContain("Seek 重构");
	});

	test("marks nothing for a scattered subsequence match", () => {
		expect(listHtml("ds")).not.toContain("<mark");
	});

	test("renders plain titles when no search is active", () => {
		expect(listHtml()).not.toContain("<mark");
	});
});

describe("sidebar search affordance", () => {
	test("offers a keyboard-reachable toggle while the box is closed", () => {
		const html = sidebarHtml({ nodes: [node("n1", "Task", ago(HOUR))] });
		expect(html).not.toContain("<input");
		// The toggle carries its own accelerator hint and reports the collapsed
		// state, so the box is reachable without a pointer.
		expect(/data-search-toggle="true"[^>]*aria-expanded="false"/.test(html)).toBe(true);
		expect(html).toContain(`aria-label="${t("search sessions…")}"`);
	});
});

describe("date-grouped list under search", () => {
	test("keeps its empty-workspace fallback without a query", () => {
		const html = renderToStaticMarkup(
			<GroupedSessionList nodes={[]} selectedId={null} onSelect={() => {}} searchQuery="" />,
		);
		expect(html).toContain(t("no sessions yet"));
	});

	test("drops the fallback while a query owns the result", () => {
		// A query can match only pinned/scheduled sessions; the sections that did
		// render carry the result, so the empty-workspace copy would contradict
		// what the user sees.
		const html = renderToStaticMarkup(
			<GroupedSessionList nodes={[]} selectedId={null} onSelect={() => {}} searchQuery="deep" />,
		);
		expect(html).not.toContain(t("no sessions yet"));
	});
});
