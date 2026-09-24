import { describe, expect, it } from "bun:test";
import { GuiSessionStore } from "../src/lib/session-store";

/**
 * session_leaf_moved handling (GuiSessionStore).
 *
 * The daemon broadcasts `session_leaf_moved` after session.branchAt (撤回/
 * 编辑/重试/branch switch moved the session tree leaf IN PLACE). The event
 * projects no transcript rows, so the store's only honest reaction is to fire
 * the onLeafMoved hook — the app layer re-fetches session.resume and hands it
 * to reloadFromSnapshot, which re-aligns the journal watermark to the fresh
 * snapshot cursor. Regressions covered here:
 *
 * - no hook fire → the transcript keeps rendering the dropped tail forever
 *   (the store is event-stream-fed and leaf moves append no entries);
 * - watermark NOT re-aligned after the refresh → in-flight/replayed frames at
 *   seqs ≤ the new cursor are re-applied as duplicates (append-only entries
 *   double) or strand the reorder buffer (a hole nobody will fill freezes the
 *   transcript until the gap-guard resync).
 */

function seqLevel(seq: number) {
	return {
		kind: "event" as const,
		seq,
		payload: { type: "thinking_level_changed", thinkingLevel: `lvl-${seq}` },
	};
}

function leafMoved(seq: number, leafId: string | null) {
	return {
		kind: "event" as const,
		seq,
		payload: { type: "session_leaf_moved", leafId },
	};
}

function levels(store: GuiSessionStore): string[] {
	return store.getSnapshot().entries.map(e => (e as { thinkingLevel?: string }).thinkingLevel ?? "?");
}

/** apply() frame-coalesces via a microtask flush — yield twice before reading. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("GuiSessionStore session_leaf_moved", () => {
	it("fires onLeafMoved with the wire leafId and keeps the watermark flowing", async () => {
		const moved: Array<string | null> = [];
		const store = new GuiSessionStore("s1", { entries: [], cursor: 3 }, "/work", {
			onLeafMoved: leafId => {
				moved.push(leafId);
			},
		});
		store.apply(leafMoved(4, "user:111"));
		await settle();
		// Regression: no hook fire → the app never re-fetches the snapshot and
		// the transcript renders the pre-rewind active path forever.
		expect(moved).toEqual(["user:111"]);
		// The event consumed seq 4 (real journal seq): the stream continues.
		store.apply(seqLevel(5));
		await settle();
		expect(levels(store)).toEqual(["lvl-5"]);
		// A replay of the already-consumed seq drops (catchup overlap).
		store.apply(leafMoved(4, "user:111"));
		await settle();
		expect(moved).toEqual(["user:111"]);
		expect(levels(store)).toEqual(["lvl-5"]);
	});

	it("fires onLeafMoved(null) for the ROOT rewind", async () => {
		const moved: Array<string | null> = [];
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/work", {
			onLeafMoved: leafId => {
				moved.push(leafId);
			},
		});
		store.apply(leafMoved(1, null));
		await settle();
		expect(moved).toEqual([null]);
	});

	it("reloadFromSnapshot re-aligns the watermark: fresh cursor is authoritative", async () => {
		const store = new GuiSessionStore("s1", { entries: [], cursor: 3 }, "/work");
		store.apply(leafMoved(4, "user:111"));
		await settle();
		// The app-layer hook re-fetches session.resume and hands the fresh
		// snapshot (cursor = journal tail at snapshot time = 9) to the store.
		store.reloadFromSnapshot({
			entries: [{ type: "thinking_level_change", id: "tlc-9", parentId: null, thinkingLevel: "lvl-9" }] as never,
			cursor: 9,
			tail: { hasMore: true, beforeId: "e0" },
		});
		expect(levels(store)).toEqual(["lvl-9"]);
		expect(store.hasMore).toBe(true);
		expect(store.historyBeforeId).toBe("e0");
		// Frames the snapshot already covers (seq ≤ 9) drop as duplicates —
		// re-appending them would double the append-only entries.
		store.apply(seqLevel(5));
		store.apply(leafMoved(4, "user:111"));
		await settle();
		expect(levels(store)).toEqual(["lvl-9"]);
		// The next live frame applies immediately (no stall at the seam).
		store.apply(seqLevel(10));
		await settle();
		expect(levels(store)).toEqual(["lvl-9", "lvl-10"]);
	});

	it("reloadFromSnapshot clears a stranded reorder buffer (no gap-guard deadlock)", async () => {
		const gaps: number[] = [];
		const store = new GuiSessionStore("s1", { entries: [], cursor: 5 }, "/work", {
			onGapDetected: (afterSeq: number) => {
				gaps.push(afterSeq);
				return Promise.resolve({ resyncRequired: false });
			},
		});
		// A hole opens (6 missing) and 7 buffers.
		store.apply(seqLevel(7));
		await settle();
		expect(levels(store)).toEqual([]);
		expect(gaps).toEqual([5]);
		// The leaf_moved refresh supersedes the hole: the fresh snapshot
		// contains everything through its cursor (9), so the buffered 7 and
		// the missing 6 are both inside it. After the reload the stream must
		// flow from 10 — not stall on the cleared gap until the 10s guard
		// escalates to a full resync.
		store.reloadFromSnapshot({
			entries: [{ type: "thinking_level_change", id: "tlc-9", parentId: null, thinkingLevel: "lvl-9" }] as never,
			cursor: 9,
		});
		expect(levels(store)).toEqual(["lvl-9"]);
		store.apply(seqLevel(10));
		await settle();
		expect(levels(store)).toEqual(["lvl-9", "lvl-10"]);
		expect(gaps).toEqual([5]);
	});
});
