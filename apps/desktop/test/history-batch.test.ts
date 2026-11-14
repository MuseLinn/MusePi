import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import {
	type FetchHistoryPage,
	HISTORY_PAGE_MESSAGES,
	HISTORY_TURN_ALIGNMENT_EXTRA_PAGES,
	type HistoryPageLike,
	loadAlignedHistoryBatch,
} from "../src/lib/history-batch";

/**
 * Turn-aligned history backfill.
 *
 * The failure this defends: the batch boundary is arbitrary, so the oldest
 * loaded turn is a fragment. The rail's top tick then stands for a turn whose
 * earlier half is not loaded, and clicking it scrolls to a piece of a turn —
 * with no error, just the wrong content on screen. The daemon cursor stays
 * authoritative either way; only the batch's oldest entry is at stake.
 */

let seq = 0;
function user(text: string): SessionEntry {
	seq += 1;
	return {
		type: "message",
		id: `u${seq}`,
		parentId: null,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		message: { role: "user", timestamp: seq, content: text },
	} as unknown as SessionEntry;
}
function advisor(text: string): SessionEntry {
	seq += 1;
	return {
		type: "custom_message",
		id: `a${seq}`,
		parentId: null,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		customType: "advisor",
		display: true,
		content: `<advisory>${text}</advisory>`,
		details: { notes: [{ note: text }] },
	} as unknown as SessionEntry;
}
function assistant(text: string): SessionEntry {
	seq += 1;
	return {
		type: "message",
		id: `s${seq}`,
		parentId: null,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		message: {
			role: "assistant",
			timestamp: seq,
			content: [{ type: "text", text }],
		},
	} as unknown as SessionEntry;
}

/** Oldest-first page, exactly as `session.history` returns one. */
function page(entries: SessionEntry[], hasMore: boolean, nextBeforeId: string | null): HistoryPageLike {
	return {
		entries,
		hasMore,
		remaining: hasMore ? entries.length * 10 : 0,
		nextBeforeId,
	};
}

/** Serves `pages` keyed by cursor; a cursor with no page is an empty tail. */
function server(pages: Record<string, HistoryPageLike>): {
	fetch: FetchHistoryPage;
	calls: string[];
} {
	const calls: string[] = [];
	const fetch: FetchHistoryPage = async beforeId => {
		calls.push(beforeId);
		return pages[beforeId] ?? null;
	};
	return { fetch, calls };
}

describe("loadAlignedHistoryBatch", () => {
	test("one read when the page already starts on a turn", async () => {
		const first = user("first turn");
		const s = server({ c1: page([first, assistant("a")], true, "c2") });
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toEqual(["c1"]);
		expect(batch.entries[0]?.id).toBe(first.id);
		expect(batch.nextBeforeId).toBe("c2");
	});

	test("walks back until the batch starts on a user prompt", async () => {
		// Page 1 starts mid-turn (an assistant row) → one more read.
		const turnStart = user("older turn");
		const s = server({
			c1: page([assistant("mid-turn tail"), assistant("more")], true, "c2"),
			c2: page([turnStart, assistant("rest")], false, null),
		});
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toEqual(["c1", "c2"]);
		// Oldest-first across pages: the turn start now leads the batch.
		expect(batch.entries[0]?.id).toBe(turnStart.id);
		expect(batch.entries).toHaveLength(4);
		// The daemon cursor from the OLDEST page is authoritative, not c1's.
		expect(batch.nextBeforeId).toBeNull();
		expect(batch.remaining).toBe(0);
	});

	test("treats a displayed advisor note as a turn boundary", async () => {
		// Agent-initiated rounds have no user prompt, so a user-only test would
		// keep reading past a perfectly whole advisor turn.
		const note = advisor("watch the ms round-trip");
		const s = server({
			c1: page([assistant("tail"), assistant("more")], true, "c2"),
			c2: page([note], false, null),
		});
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toEqual(["c1", "c2"]);
		expect(batch.entries[0]?.id).toBe(note.id);
	});

	test("does not treat a HIDDEN advisor note as a boundary", async () => {
		const hidden = { ...advisor("hidden"), display: false } as SessionEntry;
		const s = server({
			c1: page([hidden], true, "c2"),
			c2: page([user("real turn")], false, null),
		});
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toEqual(["c1", "c2"]);
		expect(batch.entries[0]?.id).toBe(`u${seq}`);
	});

	test("bounds the walk at two extra reads", async () => {
		const s = server({
			c1: page([assistant("a")], true, "c2"),
			c2: page([assistant("b")], true, "c3"),
			c3: page([assistant("c")], true, "c4"),
			c4: page([user("never reached")], false, null),
		});
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toHaveLength(1 + HISTORY_TURN_ALIGNMENT_EXTRA_PAGES);
		expect(s.calls).not.toContain("c4");
		// Unaligned is still better than nothing: the batch is kept as read.
		expect(batch.entries).toHaveLength(3);
	});

	test("stops on a repeated cursor instead of replaying the page", async () => {
		// A daemon that keeps handing back the same anchor would otherwise
		// spin; upstream throws here, we stop and keep what we have.
		const loop: HistoryPageLike = page([assistant("loop")], true, "c1");
		const s = server({ c1: loop });
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toEqual(["c1"]);
		expect(batch.entries).toHaveLength(1);
	});

	test("reports a refused cursor as stale with nothing to commit", async () => {
		const s: FetchHistoryPage = async () => ({
			entries: [],
			hasMore: true,
			remaining: 9,
			stale: true,
		});
		const batch = await loadAlignedHistoryBatch(s, "c1");
		expect(batch.stale).toBe(true);
		expect(batch.entries).toEqual([]);
	});

	test("propagates a stale verdict found on an alignment read", async () => {
		const calls: string[] = [];
		const fetch: FetchHistoryPage = async beforeId => {
			calls.push(beforeId);
			return beforeId === "c2"
				? { entries: [], hasMore: true, remaining: 5, stale: true }
				: page([assistant("mid-turn")], true, "c2");
		};
		const batch = await loadAlignedHistoryBatch(fetch, "c1");
		expect(calls).toEqual(["c1", "c2"]);
		expect(batch.stale).toBe(true);
		expect(batch.entries).toEqual([]);
	});

	test("stops on an empty page that still claims history", async () => {
		const s = server({
			c1: page([assistant("mid-turn")], true, "c2"),
			c2: page([], true, "c3"),
			c3: page([user("unreachable")], false, null),
		});
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toEqual(["c1", "c2"]);
		expect(batch.entries).toHaveLength(1);
	});

	test("does not read past the end of history", async () => {
		const s = server({ c1: page([assistant("only page")], false, null) });
		const batch = await loadAlignedHistoryBatch(s.fetch, "c1");
		expect(s.calls).toEqual(["c1"]);
		expect(batch.entries).toHaveLength(1);
	});

	test("treats a missing page as nothing to commit rather than an error", async () => {
		const s: FetchHistoryPage = async () => null;
		const batch = await loadAlignedHistoryBatch(s, "c1");
		expect(batch).toEqual({
			entries: [],
			remaining: 0,
			nextBeforeId: null,
			stale: false,
		});
	});

	test("requests the upstream page size", () => {
		// Pinned because it is a wire contract with the daemon's bounded read,
		// not a tuning knob: 100 messages is several screens of transcript, and
		// alignment reads at most two more.
		expect(HISTORY_PAGE_MESSAGES).toBe(100);
		expect(HISTORY_TURN_ALIGNMENT_EXTRA_PAGES).toBe(2);
	});
});
