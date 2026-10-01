/**
 * Unit tests for the daemon's cross-session query tables
 * (src/daemon/view-store.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WireMessage } from "@musepi/pi-wire";
import type { SessionSnapshot } from "@musepi/sdk";
import { ViewStore } from "../../src/daemon/view-store";

const dirs: string[] = [];
const stores: ViewStore[] = [];

function tempStore(opts?: ConstructorParameters<typeof ViewStore>[1]): ViewStore {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "vstore-test-"));
	dirs.push(d);
	// Default the snapshot-JSON throttle to 0 so multi-upsert assertions on
	// load() stay deterministic; P1-13 throttle tests opt into a large
	// interval explicitly.
	const store = new ViewStore(path.join(d, "materialized.db"), { minSnapshotJsonIntervalMs: 0, ...opts });
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
	messages: WireMessage[],
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
		const now = Date.now();
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "hello world", timestamp: now - 5000 },
					{ role: "user", content: "second message", timestamp: now - 4000 },
				],
				2,
				"claude-3",
			),
		);
		store.upsert("s2", snapshot("s2", [{ role: "user", content: "another hello", timestamp: now - 1000 }], 1));

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
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "v1", timestamp: Date.now() - 2000 }], 1));
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "v1", timestamp: Date.now() - 2000 },
					{ role: "user", content: "v2", timestamp: Date.now() - 1000 },
				],
				2,
			),
		);
		const list = store.list();
		expect(list.find(r => r.sessionId === "s1")!.messageCount).toBe(2);
	});

	test("updated_at is the last-entry time, not the persist wall-clock (open must not re-rank)", () => {
		const store = tempStore();
		const now = Date.now();
		const day = 86_400_000;
		const old = snapshot("s1", [{ role: "user", content: "old talk", timestamp: now - 5 * day }], 1);
		store.upsert("s1", old);
		const afterOpen = store.list().find(r => r.sessionId === "s1")!.updatedAt;
		// Opening a history session persists its snapshot (activate + idle-close
		// dispose) — neither may stamp "now", or the session jumps to the top of
		// the sidebar for merely being viewed (bitfun: "rows do not jump to the
		// top on click"; openchamber time.updated = last data change).
		expect(Math.abs(afterOpen - (now - 5 * day))).toBeLessThan(2000);
		store.upsert("s1", old);
		expect(store.list().find(r => r.sessionId === "s1")!.updatedAt).toBe(afterOpen);
		// A genuinely new message DOES bump it.
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "old talk", timestamp: now - 5 * day },
					{ role: "user", content: "fresh talk", timestamp: now - 1000 },
				],
				2,
			),
		);
		expect(Math.abs(store.list().find(r => r.sessionId === "s1")!.updatedAt - (now - 1000))).toBeLessThan(2000);
		// An empty session (no entries yet) falls back to the header timestamp.
		const fresh = snapshot("s2", [], 0);
		store.upsert("s2", fresh);
		expect(store.list().find(r => r.sessionId === "s2")!.updatedAt).toBe(Date.parse("2026-08-02T00:00:00.000Z"));
	});

	test("mode_id round-trips through upsert/list and syncs on re-persist", () => {
		const store = tempStore();
		// Historical session without a preset → null (the GUI hover card hides
		// nothing — it falls back to the default-mode label).
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "x", timestamp: 1 }], 1));
		expect(store.list().find(r => r.sessionId === "s1")!.modeId).toBeNull();
		// Preset id is read off the snapshot header (cast — the SDK header type
		// predates the field, mirroring view-store.ts's own read).
		const withMode = snapshot("s2", [{ role: "user", content: "y", timestamp: 1 }], 1);
		(withMode.header as { modeId?: string }).modeId = "design";
		store.upsert("s2", withMode);
		expect(store.list().find(r => r.sessionId === "s2")!.modeId).toBe("design");
		// Switching presets re-persists the snapshot → the column must follow
		// (ON CONFLICT update), not stick at the first value.
		(withMode.header as { modeId?: string }).modeId = "work";
		store.upsert("s2", withMode);
		expect(store.list().find(r => r.sessionId === "s2")!.modeId).toBe("work");
	});

	test("a later view-snapshot persist must not clobber a persisted preset", () => {
		const store = tempStore();
		// 1) persistHeaderPatch arms the preset off the snapshot header.
		const armed = snapshot("s1", [{ role: "user", content: "y", timestamp: 1 }], 1);
		(armed.header as { modeId?: string }).modeId = "design";
		store.upsert("s1", armed);
		expect(store.list().find(r => r.sessionId === "s1")!.modeId).toBe("design");
		// 2) a streaming schedulePersist / idle-close replays the MaterializedView
		//    projection, whose header has NO modeId key — this used to null the
		//    preset (BUG: hover card fell back to 工作模式 after restart).
		const replay = snapshot(
			"s1",
			[
				{ role: "user", content: "y", timestamp: 1 },
				{ role: "assistant", content: "reply", timestamp: 2 },
			] as never,
			2,
		);
		store.upsert("s1", replay);
		expect(store.list().find(r => r.sessionId === "s1")!.modeId).toBe("design");
		// 3) the stored snapshot header carries the preset too, so adopt() can
		//    restore live.modeId after a restart (not just the query column).
		expect((store.load("s1")!.header as { modeId?: string }).modeId).toBe("design");
		// 4) an explicit clear (persistHeaderPatch with null) still wins.
		const cleared = snapshot("s1", [{ role: "user", content: "y", timestamp: 1 }], 1);
		(cleared.header as { modeId?: string }).modeId = null as never;
		store.upsert("s1", cleared);
		expect(store.list().find(r => r.sessionId === "s1")!.modeId).toBeNull();
	});

	test("mcpServers (M4 P1 connector allowlist) round-trips, survives replays, [] ≠ null", () => {
		const store = tempStore();
		// Unconfigured session → null (legacy all-on semantics for the composer
		// chip: the GUI shows "not configured", not "zero connectors").
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "x", timestamp: 1 }], 1));
		expect(store.list().find(r => r.sessionId === "s1")!.mcpServers).toBeNull();
		// Explicit selection arms off the snapshot header (persistHeaderPatch write).
		const armed = snapshot("s2", [{ role: "user", content: "y", timestamp: 1 }], 1);
		(armed.header as { mcpServers?: string[] }).mcpServers = ["alpha", "beta"];
		store.upsert("s2", armed);
		expect(store.list().find(r => r.sessionId === "s2")!.mcpServers).toEqual(["alpha", "beta"]);
		// Switching the selection re-persists → the column follows.
		(armed.header as { mcpServers?: string[] }).mcpServers = ["gamma"];
		store.upsert("s2", armed);
		expect(store.list().find(r => r.sessionId === "s2")!.mcpServers).toEqual(["gamma"]);
		// A streaming replay (view snapshot WITHOUT the key) must not clobber the
		// selection — same bug class as the modeId nulling above.
		const replay = snapshot(
			"s2",
			[
				{ role: "user", content: "y", timestamp: 1 },
				{ role: "assistant", content: "reply", timestamp: 2 },
			] as never,
			2,
		);
		store.upsert("s2", replay);
		expect(store.list().find(r => r.sessionId === "s2")!.mcpServers).toEqual(["gamma"]);
		// The stored snapshot header carries it too, so adopt() can rehydrate the
		// SessionTools allowlist after a restart.
		expect((store.load("s2")!.header as { mcpServers?: string[] }).mcpServers).toEqual(["gamma"]);
		// Configured-EMPTY is a meaningful state (zero MCP tools in the session)
		// and must round-trip through rewrites — the classic falsy-value trap.
		const emptied = snapshot("s2", [{ role: "user", content: "y", timestamp: 1 }], 1);
		(emptied.header as { mcpServers?: string[] }).mcpServers = [];
		store.upsert("s2", emptied);
		expect(store.list().find(r => r.sessionId === "s2")!.mcpServers).toEqual([]);
		const replay2 = snapshot("s2", [{ role: "user", content: "z", timestamp: 3 }], 3);
		store.upsert("s2", replay2);
		expect(store.list().find(r => r.sessionId === "s2")!.mcpServers).toEqual([]);
		// An explicit clear (header key = null) wins over preservation.
		const cleared = snapshot("s2", [{ role: "user", content: "y", timestamp: 1 }], 1);
		(cleared.header as { mcpServers?: string[] | null }).mcpServers = null;
		store.upsert("s2", cleared);
		expect(store.list().find(r => r.sessionId === "s2")!.mcpServers).toBeNull();
	});

	test("search matches message text across sessions, newest first", () => {
		const store = tempStore();
		const now = Date.now();
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "fix the login bug", timestamp: now - 2000 },
					{ role: "user", content: "unrelated", timestamp: now - 1900 },
				],
				2,
			),
		);
		store.upsert("s2", snapshot("s2", [{ role: "user", content: "login flow broken", timestamp: now - 1000 }], 1));

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
					} as unknown as WireMessage,
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

describe("ViewStore incremental projection (P1-13)", () => {
	// 失败模式：流式期间每次 100ms persist 都 DELETE 全表 + 逐条重插 +
	// 整体 JSON.stringify（10⁴ 行 × 10/s 的同步事务阻塞事件循环）。断言
	// 写入行数与本次变更量成正比（hooks 计数桩），且检索内容保持新鲜。
	test("content-only persist updates just the changed row (search stays fresh, no full rewrite)", () => {
		const writes: Array<{ kind: string; count: number }> = [];
		const store = tempStore({ hooks: { onMessageRows: (kind, count) => writes.push({ kind, count }) } });
		const now = Date.now();
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "partial answer", timestamp: now - 1000 }], 1));

		// 流式内容帧：同 id 新对象（MaterializedView upsert 形状）。
		const updatedEntry = {
			type: "message" as const,
			id: "m0",
			parentId: null,
			timestamp: new Date(now - 1000).toISOString(),
			message: { role: "user" as const, content: "partial answer, now complete", timestamp: now - 1000 },
		};
		const snap2 = snapshot(
			"s1",
			[{ role: "user", content: "partial answer, now complete", timestamp: now - 1000 }],
			2,
		);
		snap2.entries = [updatedEntry];
		store.upsert("s1", snap2, null, { changed: [updatedEntry] });

		expect(store.search("now complete")).toHaveLength(1);
		expect(store.search("partial answer")).toHaveLength(1); // 同一条，不是第二条
		// 首 upsert 必然是 full；断言的是第二次 persist 没有再走全量重建。
		expect(writes.filter(w => w.kind === "full")).toHaveLength(1);
		expect(writes.filter(w => w.kind === "update")).toEqual([{ kind: "update", count: 1 }]);
	});

	test("append persist inserts only the new tail rows", () => {
		const writes: Array<{ kind: string; count: number }> = [];
		const store = tempStore({ hooks: { onMessageRows: (kind, count) => writes.push({ kind, count }) } });
		const now = Date.now();
		store.upsert(
			"s1",
			snapshot(
				"s1",
				[
					{ role: "user", content: "one", timestamp: now - 3000 },
					{ role: "assistant", content: "two", timestamp: now - 2000 } as unknown as WireMessage,
				],
				2,
			),
		);
		const third = {
			type: "message" as const,
			id: "m2",
			parentId: null,
			timestamp: new Date(now - 1000).toISOString(),
			message: { role: "user" as const, content: "three", timestamp: now - 1000 },
		};
		const snap2 = snapshot(
			"s1",
			[
				{ role: "user", content: "one", timestamp: now - 3000 },
				{ role: "assistant", content: "two", timestamp: now - 2000 } as unknown as WireMessage,
			],
			2,
		);
		snap2.entries = [...snap2.entries, third];
		store.upsert("s1", snap2, null, { changed: [third] });

		const rows = store.messagesFor("s1");
		expect(rows.map(r => r.content)).toEqual(["one", "two", "three"]);
		expect(rows.map(r => r.seq)).toEqual([0, 1, 2]);
		// 首 upsert 必然是 full；断言的是追加 persist 只走 append 通道。
		expect(writes.filter(w => w.kind === "full")).toHaveLength(1);
		expect(writes.filter(w => w.kind === "append")).toEqual([{ kind: "append", count: 1 }]);
	});

	test("a persist with no changes writes zero message rows", () => {
		let writeCount = 0;
		const store = tempStore({ hooks: { onMessageRows: () => writeCount++ } });
		const now = Date.now();
		const snap = snapshot("s1", [{ role: "user", content: "steady", timestamp: now - 1000 }], 1);
		store.upsert("s1", snap);
		// turn_start/agent_end 帧：同一 entries 引用、无 dirty——非内容 persist。
		store.upsert("s1", snap, null, { changed: [] });
		expect(writeCount).toBe(1); // 仅首 upsert 的 full
		expect(store.search("steady")).toHaveLength(1);
	});

	test("prepend/misalignment falls back to a full rebuild and stays consistent", () => {
		const writes: Array<{ kind: string; count: number }> = [];
		const store = tempStore({ hooks: { onMessageRows: (kind, count) => writes.push({ kind, count }) } });
		const now = Date.now();
		store.upsert("s1", snapshot("s1", [{ role: "user", content: "newer", timestamp: now - 1000 }], 1));
		// 前插一条更老的消息：newer 的 id (m0) 从 seq 0 挪到 seq 1，位置对齐被破坏。
		const older = {
			type: "message" as const,
			id: "old-1",
			parentId: null,
			timestamp: new Date(now - 5000).toISOString(),
			message: { role: "user" as const, content: "older", timestamp: now - 5000 },
		};
		const snap2 = snapshot("s1", [{ role: "user", content: "newer", timestamp: now - 1000 }], 2);
		snap2.entries = [older, ...snap2.entries];
		store.upsert("s1", snap2, null, { changed: [older] });

		const rows = store.messagesFor("s1");
		expect(rows.map(r => r.content)).toEqual(["older", "newer"]);
		expect(writes.filter(w => w.kind === "full")).toHaveLength(2);
	});

	test("snapshot JSON is throttled while streaming; force bypasses", () => {
		const store = tempStore({ minSnapshotJsonIntervalMs: 60_000 });
		const now = Date.now();
		const snap1 = snapshot("s1", [{ role: "user", content: "v1", timestamp: now - 1000 }], 1);
		store.upsert("s1", snap1);
		expect(store.load("s1")?.cursor).toBe(1);

		// 非内容帧（同 entries 引用，cursor 前进）：JSON 被节流，cursor 不前进。
		const snap2 = { ...snap1, cursor: 5 };
		store.upsert("s1", snap2, null, { changed: [] });
		expect(store.load("s1")?.cursor).toBe(1);

		// force（dispose/compaction 语义）：立即写。
		store.upsert("s1", { ...snap1, cursor: 9 }, null, { force: true });
		expect(store.load("s1")?.cursor).toBe(9);
	});

	test("remove clears the incremental state — a resurrected session rebuilds fully", () => {
		const writes: Array<{ kind: string; count: number }> = [];
		const store = tempStore({ hooks: { onMessageRows: (kind, count) => writes.push({ kind, count }) } });
		const now = Date.now();
		const snap = snapshot("s1", [{ role: "user", content: "again", timestamp: now - 1000 }], 1);
		store.upsert("s1", snap);
		store.remove("s1");
		store.upsert("s1", snap);
		expect(writes.filter(w => w.kind === "full")).toHaveLength(2);
		expect(store.search("again")).toHaveLength(1);
	});
});
