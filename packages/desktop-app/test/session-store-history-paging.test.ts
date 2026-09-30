import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { GuiSessionStore } from "../src/lib/session-store";

/**
 * History-paging progress contract (P0-3) at the store layer:
 *
 * - hasMore with a null tail cursor derives the anchor from the oldest
 *   LOADED entry (P0-8) — history must never be walled off silently.
 * - A fully-overlapped page adopts the daemon's explicit nextBeforeId when
 *   the view holds it: monotone progress instead of a scroll-driven retry
 *   loop on the same cursor.
 * - A page that advances nothing while history remains (and no usable
 *   anchor) fails soft: warn + fold closed, not an infinite zero-progress
 *   RPC loop.
 * - markHistoryStale closes the fold on the daemon's stale verdict.
 */

let n = 0;
function msg(text: string): SessionEntry {
	n += 1;
	const ts = Date.UTC(2026, 0, 1, 0, 0, n);
	return {
		type: "message",
		id: `m${n}`,
		parentId: null,
		timestamp: new Date(ts).toISOString(),
		message: { role: "user", timestamp: ts, content: text },
	} as unknown as SessionEntry;
}

function storeWithTail(entries: SessionEntry[], hasMore = true): GuiSessionStore {
	return new GuiSessionStore("s1", { entries, cursor: 0, tail: { hasMore, beforeId: null } }, "/tmp");
}

describe("GuiSessionStore history paging (P0-3)", () => {
	it("derives the cursor from the oldest loaded entry when the tail ships hasMore + null beforeId (P0-8)", () => {
		const e1 = msg("a");
		const e2 = msg("b");
		const store = storeWithTail([e1, e2]);
		expect(store.hasMore).toBe(true);
		expect(store.historyBeforeId).toBe(e1.id);
	});

	it("keeps hasMore false when the tail says the window is complete", () => {
		const store = storeWithTail([msg("a")], false);
		expect(store.hasMore).toBe(false);
		expect(store.historyBeforeId).toBeNull();
	});

	it("advances the cursor to the fresh oldest entry on a normal page", () => {
		const e2 = msg("b");
		const store = storeWithTail([e2]);
		const older = [msg("older-1")];
		store.prependEntries(older, 0, older[0]?.id ?? null);
		expect(store.historyBeforeId).toBe(older[0]?.id);
		expect(store.hasMore).toBe(false); // remaining = 0
		const snap = store.getSnapshot();
		expect(snap.entries[0]?.id).toBe(older[0]?.id);
	});

	it("adopts the daemon's nextBeforeId when the page is fully overlapped — progress, not a retry loop", () => {
		const e1 = msg("a");
		const e2 = msg("b");
		const store = storeWithTail([e1, e2]);
		// The daemon answered with a page the view already holds (duplicate-id
		// boundary ambiguity) plus an explicit next anchor the view holds and
		// that differs from the current cursor — the store must adopt it so
		// the following page advances instead of replaying this one.
		store.prependEntries([e1], 3, e2.id);
		expect(store.historyBeforeId).toBe(e2.id);
		expect(store.hasMore).toBe(true);
	});

	it("fails soft on a zero-progress page with history remaining: fold closes instead of looping", () => {
		const e1 = msg("a");
		const store = storeWithTail([e1]);
		// All entries already held AND the daemon's next anchor is unusable
		// (not held) — the same request would replay forever on scroll.
		store.prependEntries([e1], 5, "not-held");
		expect(store.hasMore).toBe(false);
	});

	it("fails soft on an empty page that claims history remains", () => {
		const store = storeWithTail([msg("a")]);
		store.prependEntries([], 4, null);
		expect(store.hasMore).toBe(false);
	});

	it("markHistoryStale closes the fold after the daemon's stale verdict", () => {
		const store = storeWithTail([msg("a")]);
		store.markHistoryStale();
		expect(store.hasMore).toBe(false);
	});

	it("multi-page walk makes monotone progress without repeating entries", () => {
		const t1 = msg("t1");
		const t2 = msg("t2");
		const store = storeWithTail([t1, t2]);
		const page1 = [msg("p1a"), msg("p1b")];
		store.prependEntries(page1, 2, page1[0]?.id ?? null);
		expect(store.historyBeforeId).toBe(page1[0]?.id);
		expect(store.hasMore).toBe(true);
		const page2 = [msg("p2a")];
		store.prependEntries(page2, 0, page2[0]?.id ?? null);
		expect(store.historyBeforeId).toBe(page2[0]?.id);
		expect(store.hasMore).toBe(false);
		const ids = store.getSnapshot().entries.map(e => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids[0]).toBe(page2[0]?.id);
	});
});
