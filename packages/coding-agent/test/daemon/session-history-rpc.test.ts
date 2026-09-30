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
