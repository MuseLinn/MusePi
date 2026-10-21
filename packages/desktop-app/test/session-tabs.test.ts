/**
 * Contract tests for the header session-tabs working set.
 *
 * Failure modes defended: the strip auto-grows on every session open, so a
 * missing cap would grow it without bound; closing the active tab without a
 * neighbour rule would land on a random session (or none) instead of the
 * right-then-left neighbour; and ids whose session has not loaded must stay
 * stored yet never render or receive activation — otherwise a lagging
 * session.list poll silently destroys the working set.
 */
import { describe, expect, it } from "bun:test";
import {
	adjacentTabId,
	closeOtherTabIds,
	closeTabAndActivateNeighbour,
	ensureTabId,
	loadTabIds,
	MAX_SESSION_TABS,
	removeTabId,
	reorderTabIds,
	SESSION_TAB_IDS_KEY,
	saveTabIds,
	tabIdAtIndex,
} from "../src/lib/session-tabs";

const allRenderable = () => true;

describe("ensureTabId", () => {
	it("appends once and never duplicates", () => {
		const once = ensureTabId([], "a");
		expect(once).toEqual(["a"]);
		expect(ensureTabId(once, "a")).toEqual(["a"]);
	});

	it("past the cap drops the oldest tab, never the one being opened", () => {
		let ids: string[] = [];
		for (let i = 0; i < MAX_SESSION_TABS + 3; i += 1) {
			ids = ensureTabId(ids, `s${i}`);
		}
		expect(ids).toHaveLength(MAX_SESSION_TABS);
		expect(ids.at(-1)).toBe(`s${MAX_SESSION_TABS + 2}`);
		expect(ids[0]).toBe("s3");
	});
});

describe("closeTabAndActivateNeighbour", () => {
	it("closing a background tab only removes it", () => {
		const { ids, nextId } = closeTabAndActivateNeighbour(["a", "b", "c"], "a", "b", allRenderable);
		expect(ids).toEqual(["b", "c"]);
		expect(nextId).toBeNull();
	});

	it("closing the active tab activates the right neighbour first", () => {
		expect(closeTabAndActivateNeighbour(["a", "b", "c"], "a", "a", allRenderable).nextId).toBe("b");
		expect(closeTabAndActivateNeighbour(["a", "b", "c"], "b", "b", allRenderable).nextId).toBe("c");
	});

	it("falls back left when the active tab was last", () => {
		expect(closeTabAndActivateNeighbour(["a", "b"], "b", "b", allRenderable).nextId).toBe("a");
	});

	it("reports null when the last tab closed, so the caller opens a new draft", () => {
		expect(closeTabAndActivateNeighbour(["a"], "a", "a", allRenderable).nextId).toBeNull();
	});

	it("unknown sessions never become neighbours", () => {
		const renderable = (id: string) => id !== "ghost";
		const { ids, nextId } = closeTabAndActivateNeighbour(["a", "ghost", "b"], "a", "a", renderable);
		expect(ids).toEqual(["ghost", "b"]);
		expect(nextId).toBe("b");
	});

	it("keeps unknown ids stored when they are not the one closed", () => {
		const { ids } = closeTabAndActivateNeighbour(["a", "ghost", "b"], "b", "a", allRenderable);
		expect(ids).toEqual(["a", "ghost"]);
	});
});

describe("adjacentTabId", () => {
	it("wraps around both ends of the rendered order", () => {
		expect(adjacentTabId(["a", "b", "c"], "c", 1, allRenderable)).toBe("a");
		expect(adjacentTabId(["a", "b", "c"], "a", -1, allRenderable)).toBe("c");
	});

	it("skips unknown sessions in the rendered order", () => {
		const renderable = (id: string) => id !== "ghost";
		expect(adjacentTabId(["a", "ghost", "b"], "a", 1, renderable)).toBe("b");
	});

	it("returns null for a current session that has no tab", () => {
		expect(adjacentTabId(["a", "b"], "zzz", 1, allRenderable)).toBeNull();
		expect(adjacentTabId(["a"], "a", 1, allRenderable)).toBeNull();
	});
});

describe("tabIdAtIndex", () => {
	it("counts only rendered tabs and bounds-checks", () => {
		const renderable = (id: string) => id !== "ghost";
		expect(tabIdAtIndex(["a", "ghost", "b"], 1, renderable)).toBe("b");
		expect(tabIdAtIndex(["a", "b"], 5, allRenderable)).toBeNull();
	});
});

describe("reorder / close-others helpers", () => {
	it("moves the dragged tab before the target", () => {
		expect(reorderTabIds(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
		expect(reorderTabIds(["a", "b"], "x", "b")).toEqual(["a", "b"]);
	});

	it("closeOtherTabIds keeps only the given tab and ignores unknown ids", () => {
		expect(closeOtherTabIds(["a", "b", "c"], "b")).toEqual(["b"]);
		expect(closeOtherTabIds(["a"], "a")).toEqual(["a"]);
		expect(closeOtherTabIds(["a", "b"], "zzz")).toEqual(["a", "b"]);
	});
});

describe("removeTabId", () => {
	it("removes once and tolerates unknown ids", () => {
		expect(removeTabId(["a", "b"], "a")).toEqual(["b"]);
		expect(removeTabId(["a", "b"], "zzz")).toEqual(["a", "b"]);
	});
});

describe("persistence", () => {
	it("round-trips ids and tolerates corrupt JSON", () => {
		const mem = new Map<string, string>();
		const storage = {
			getItem: (k: string) => mem.get(k) ?? null,
			setItem: (k: string, v: string) => void mem.set(k, v),
		};
		saveTabIds(["a", "b"], storage);
		expect(loadTabIds(storage)).toEqual(["a", "b"]);
		mem.set(SESSION_TAB_IDS_KEY, "{not json");
		expect(loadTabIds(storage)).toEqual([]);
		mem.set(SESSION_TAB_IDS_KEY, JSON.stringify(["a", 7, "", null, "b"]));
		expect(loadTabIds(storage)).toEqual(["a", "b"]);
	});
});
