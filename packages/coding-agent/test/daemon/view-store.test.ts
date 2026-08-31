/**
 * Unit tests for the daemon's cross-session query tables
 * (src/daemon/view-store.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UserMessage } from "@musepi/pi-wire";
import type { SessionSnapshot } from "@musepi/sdk";
import { ViewStore } from "../../src/daemon/view-store";

const dirs: string[] = [];
const stores: ViewStore[] = [];

function tempStore(): ViewStore {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "vstore-test-"));
	dirs.push(d);
	const store = new ViewStore(path.join(d, "materialized.db"));
	stores.push(store);
	return store;
}

afterEach(() => {
	// Close SQLite handles BEFORE removing the directory: Windows refuses
	// to delete a file that is still open (EBUSY), so an unclosed store
	// leaves every afterEach on this platform failing with EBUSY.
	for (const store of stores.splice(0)) store.close();
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function snapshot(
	sessionId: string,
	messages: UserMessage[],
	cursor = messages.length,
	model?: string,
): SessionSnapshot {
	return {
		header: { type: "session", id: sessionId, timestamp: "2026-08-02T00:00:00.000Z", cwd: "/tmp/proj" },
		entries: messages.map((m, i) => ({
			type: "message" as const,
			id: `m${i}`,
			parentId: null,
			timestamp: new Date(m.timestamp).toISOString(),
			message: m,
		})),
		state: {
			isStreaming: false,
			queuedMessageCount: 0,
			cwd: "/tmp/proj",
			participants: [],
			...(model ? { model: { id: model, name: model, provider: "test", contextWindow: null } } : {}),
		},
		agents: [
			{
				id: "main",
				displayName: "main",
				kind: "main",
				status: "idle",
				hasSessionFile: false,
				createdAt: 1,
				lastActivity: 2,
			},
		],
		cursor,
	};
}

describe("ViewStore cross-session tables", () => {
	test("upsert populates sessions/messages/agents; list returns metadata", () => {
		const store = tempStore();
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "hello world", timestamp: 100 },
					{ role: "user", content: "second message", timestamp: 200 },
				],
				2,
				"claude-3",
			),
		);
		store.upsert("s2", snapshot("s2", [{ role: "user", content: "another hello", timestamp: 300 }], 1));

		const list = store.list();
		expect(list).toHaveLength(2);
		const s1 = list.find(r => r.sessionId === "s1")!;
		expect(s1.messageCount).toBe(2);
		expect(s1.model).toBe("test/claude-3");
		expect(s1.cwd).toBe("/tmp/proj");
		// newest first
		expect(list[0]!.sessionId).toBe("s2");
	});

	test("upsert replaces the message projection (no duplicates across persists)", () => {
		const store = tempStore();
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "v1", timestamp: 1 }], 1));
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "v1", timestamp: 1 },
					{ role: "user", content: "v2", timestamp: 2 },
				],
				2,
			),
		);
		const list = store.list();
		expect(list.find(r => r.sessionId === "s1")!.messageCount).toBe(2);
	});

	test("search matches message text across sessions, newest first", () => {
		const store = tempStore();
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "fix the login bug", timestamp: 100 },
					{ role: "user", content: "unrelated", timestamp: 110 },
				],
				2,
			),
		);
		store.upsert("s2", snapshot("s2", [{ role: "user", content: "login flow broken", timestamp: 200 }], 1));

		const hits = store.search("login");
		expect(hits).toHaveLength(2);
		expect(hits[0]!.sessionId).toBe("s2"); // newer first
		expect(hits.map(h => h.content)).toContain("fix the login bug");
		expect(hits.map(h => h.content)).toContain("login flow broken");
	});

	test("search with no matches returns empty", () => {
		const store = tempStore();
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "plain text", timestamp: 1 }], 1));
		expect(store.search("zzz-no-such-text")).toEqual([]);
	});

	test("array-content messages are flattened to text for search", () => {
		const store = tempStore();
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{
						role: "user",
						content: [
							{ type: "text", text: "multi block" },
							{ type: "text", text: "needle" },
						],
						timestamp: 1,
					} as unknown as UserMessage,
				],
				1,
			),
		);
		expect(store.search("needle")).toHaveLength(1);
	});

	test("load still serves the whole snapshot (recovery path unchanged)", () => {
		const store = tempStore();
		const snap = snapshot("s1", [{ role: "user", content: "keep", timestamp: 1 }], 1);
		store.upsert("s1", snap);
		expect(store.load("s1")).toEqual(snap);
	});

	test("remove cleans all four tables", () => {
		const store = tempStore();
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "x", timestamp: 1 }], 1));
		store.remove("s1");
		expect(store.list()).toHaveLength(0);
		expect(store.load("s1")).toBeUndefined();
		expect(store.search("x")).toEqual([]);
	});
});
