import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * session.history paging contract (P0-3):
 *
 * - A stale/unknown beforeId must be REPORTED (`stale: true`, empty page) —
 *   never silently answered with the latest page, which fully overlaps what
 *   the client holds and turns every scroll into the same zero-progress RPC.
 * - A duplicated entry id anchors at the LAST occurrence: the paging client
 *   holds the most recently materialized entry with that id, so a
 *   first-match findIndex would return a fully-overlapped page and stall.
 * - The response carries an explicit `nextBeforeId` so a fully-overlapped
 *   page can still advance the cursor (monotone progress on duplicates).
 * - Sequential paging walks backward with no repeated pages and no
 *   zero-progress replies.
 */

const SESSION = "history-s1";

function entry(id: string): { id: string } {
	return { id };
}

function serverWith(entries: { id: string }[]): { server: DaemonServer; conn: DaemonConnection } {
	const host = {
		cwd: () => "/tmp",
		snapshot: () => Promise.resolve({ entries }),
		checkpointSeq: () => Promise.resolve(0),
		get: () => undefined,
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return {
		server: new DaemonServer(host),
		conn: { id: "history-test", writableLength: () => 0, send: () => {} } as unknown as DaemonConnection,
	};
}

describe("session.history paging (P0-3)", () => {
	test("unknown beforeId is reported stale — never answered with the latest page", async () => {
		const { server, conn } = serverWith([entry("e1"), entry("e2"), entry("e3")]);
		const res = (await server.handle(
			"session.history",
			{ sessionId: SESSION, beforeId: "gone", maxMessages: 2 },
			conn,
		)) as { stale?: boolean; entries: unknown[]; hasMore: boolean; remaining: number };
		expect(res.stale).toBe(true);
		expect(res.entries).toEqual([]);
		expect(res.hasMore).toBe(false);
		expect(res.remaining).toBe(0);
	});

	test("a missing beforeId still pages from the tail (initial open has no cursor)", async () => {
		const { server, conn } = serverWith([entry("e1"), entry("e2"), entry("e3")]);
		const res = (await server.handle("session.history", { sessionId: SESSION, maxMessages: 2 }, conn)) as {
			stale?: boolean;
			entries: { id: string }[];
			hasMore: boolean;
			remaining: number;
			nextBeforeId: string | null;
		};
		expect(res.stale).toBe(false);
		expect(res.entries.map(e => e.id)).toEqual(["e2", "e3"]);
		expect(res.hasMore).toBe(true);
		expect(res.remaining).toBe(1);
		expect(res.nextBeforeId).toBe("e2");
	});

	test("duplicated entry id anchors at the LAST occurrence and returns a non-overlapped page", async () => {
		// e2 exists twice (retried journal record). The client's oldest loaded
		// entry is the second e2, so paging must return [e1] — a first-match
		// findIndex would return [e1] too here; the regression guard is the
		// duplicate-at-page-boundary shape below.
		const { server, conn } = serverWith([entry("e1"), entry("e2"), entry("e3"), entry("e2"), entry("e5")]);
		const res = (await server.handle(
			"session.history",
			{ sessionId: SESSION, beforeId: "e2", maxMessages: 10 },
			conn,
		)) as { entries: { id: string }[]; nextBeforeId: string | null; remaining: number };
		// Anchor = last e2 (index 3) → the page before it is [e1, e2, e3].
		expect(res.entries.map(e => e.id)).toEqual(["e1", "e2", "e3"]);
		expect(res.nextBeforeId).toBe("e1");
		expect(res.remaining).toBe(0);
	});

	test("sequential paging walks back with no repeated pages and monotone progress", async () => {
		const all = Array.from({ length: 23 }, (_, i) => entry(`e${i + 1}`));
		const { server, conn } = serverWith(all);
		const seen: string[] = [];
		let beforeId: string | undefined = "e23";
		for (let page = 0; page < 10; page++) {
			const res = (await server.handle(
				"session.history",
				{ sessionId: SESSION, beforeId, maxMessages: 10 },
				conn,
			)) as {
				entries: { id: string }[];
				hasMore: boolean;
				remaining: number;
				nextBeforeId: string | null;
				stale?: boolean;
			};
			expect(res.stale).not.toBe(true);
			for (const e of res.entries) {
				expect(seen).not.toContain(e.id);
				seen.push(e.id);
			}
			if (!res.hasMore || res.remaining <= 0) break;
			const next = res.nextBeforeId ?? res.entries[0]?.id ?? null;
			expect(next).not.toBeNull();
			expect(next).not.toBe(beforeId);
			beforeId = next ?? undefined;
		}
		// 23 entries minus the e23 anchor: every older entry was paged exactly
		// once (seen accumulates newest→oldest, so e1 lands at the end).
		expect(seen).toHaveLength(22);
		// Final page rides oldest→newest, so the accumulation ends with e1, e2.
		expect(seen.slice(-2)).toEqual(["e1", "e2"]);
	});

	test("maxMessages is clamped to at least 1 and at most 1000", async () => {
		const all = Array.from({ length: 5 }, (_, i) => entry(`e${i + 1}`));
		const { server, conn } = serverWith(all);
		const tiny = (await server.handle("session.history", { sessionId: SESSION, maxMessages: 0 }, conn)) as {
			entries: unknown[];
		};
		expect(tiny.entries).toHaveLength(1);
		const huge = (await server.handle("session.history", { sessionId: SESSION, maxMessages: 99999 }, conn)) as {
			entries: unknown[];
		};
		expect(huge.entries).toHaveLength(5);
	});
});

describe("session.resume history window", () => {
	test("keeps the older-history cursor after tailing the full snapshot exactly once", async () => {
		const all = Array.from({ length: 250 }, (_, index) => entry(`e${index + 1}`));
		const { server, conn } = serverWith(all);
		const res = (await server.handle("session.resume", { sessionId: SESSION }, conn)) as {
			snapshot: { entries: { id: string }[]; tail: { hasMore: boolean; beforeId: string | null } };
		};
		expect(res.snapshot.entries).toHaveLength(200);
		expect(res.snapshot.entries[0]?.id).toBe("e51");
		expect(res.snapshot.tail).toEqual({ hasMore: true, beforeId: "e51" });
	});
});

describe("session.turns paging", () => {
	function transcript(turnCount: number): { id: string }[] {
		return Array.from({ length: turnCount }, (_, index) => {
			const at = new Date(1_700_000_000_000 + index * 2000).toISOString();
			return [
				{
					id: `u${index + 1}`,
					type: "message",
					timestamp: at,
					message: { role: "user", content: `question ${index + 1}`, timestamp: Date.parse(at) },
				},
				{
					id: `a${index + 1}`,
					type: "message",
					timestamp: new Date(Date.parse(at) + 1000).toISOString(),
					message: { role: "assistant", content: `answer ${index + 1}`, timestamp: Date.parse(at) + 1000 },
				},
			];
		}).flat();
	}

	test("a limited first page returns the newest turns and beforeTurn walks older without overlap", async () => {
		const { server, conn } = serverWith(transcript(5));
		const first = (await server.handle("session.turns", { sessionId: SESSION, limit: 2 }, conn)) as {
			turns: { entryId: string }[];
			hasMore: boolean;
			nextBeforeTurn: string | null;
		};
		expect(first.turns.map(turn => turn.entryId)).toEqual(["u4", "u5"]);
		expect(first.hasMore).toBe(true);
		expect(first.nextBeforeTurn).toBe("u4");

		const second = (await server.handle(
			"session.turns",
			{ sessionId: SESSION, beforeTurn: first.nextBeforeTurn, limit: 2 },
			conn,
		)) as { turns: { entryId: string }[]; hasMore: boolean; nextBeforeTurn: string | null };
		expect(second.turns.map(turn => turn.entryId)).toEqual(["u2", "u3"]);
		expect(second.hasMore).toBe(true);

		const third = (await server.handle(
			"session.turns",
			{ sessionId: SESSION, beforeTurn: second.nextBeforeTurn, limit: 2 },
			conn,
		)) as { turns: { entryId: string }[]; hasMore: boolean };
		expect(third.turns.map(turn => turn.entryId)).toEqual(["u1"]);
		expect(third.hasMore).toBe(false);
	});

	test("an unknown beforeTurn is stale instead of overlapping the newest page", async () => {
		const { server, conn } = serverWith(transcript(3));
		const res = (await server.handle(
			"session.turns",
			{ sessionId: SESSION, beforeTurn: "gone", limit: 2 },
			conn,
		)) as {
			turns: unknown[];
			stale: boolean;
		};
		expect(res.stale).toBe(true);
		expect(res.turns).toEqual([]);
	});

	test("an unparameterized legacy request still returns the full turn index", async () => {
		const { server, conn } = serverWith(transcript(4));
		const res = (await server.handle("session.turns", { sessionId: SESSION }, conn)) as {
			turns: { entryId: string }[];
			totalEntries: number;
		};
		expect(res.turns.map(turn => turn.entryId)).toEqual(["u1", "u2", "u3", "u4"]);
		expect(res.totalEntries).toBe(8);
	});
});

describe("session.compaction", () => {
	test("returns the requested summary with post-compaction display metadata", async () => {
		const compacted = {
			...entry("c1"),
			type: "compaction",
			summary: "Keep the current task and verification evidence.",
			tokensBefore: 791_000,
			tokensAfter: 76_600,
			method: "soft",
			warning: "Keep verifying",
		};
		const { server, conn } = serverWith([compacted]);
		const res = (await server.handle("session.compaction", { sessionId: SESSION, entryId: "c1" }, conn)) as {
			entry: typeof compacted | null;
		};
		expect(res.entry).toEqual(compacted);
	});

	test("returns null for an unknown entry and preserves legacy entries without optional metadata", async () => {
		const legacy = { ...entry("legacy"), type: "compaction", summary: "Older session", tokensBefore: 1000 };
		const { server, conn } = serverWith([legacy]);
		const missing = (await server.handle("session.compaction", { sessionId: SESSION, entryId: "gone" }, conn)) as {
			entry: unknown;
		};
		expect(missing.entry).toBeNull();
		const found = (await server.handle("session.compaction", { sessionId: SESSION, entryId: "legacy" }, conn)) as {
			entry: { tokensAfter?: number; method?: string };
		};
		expect(found.entry.tokensAfter).toBeUndefined();
		expect(found.entry.method).toBeUndefined();
	});

	test("requires both session and entry ids", async () => {
		const { server, conn } = serverWith([]);
		await expect(server.handle("session.compaction", { entryId: "c1" }, conn)).rejects.toThrow("sessionId required");
		await expect(server.handle("session.compaction", { sessionId: SESSION }, conn)).rejects.toThrow(
			"entryId required",
		);
	});
});
