import { describe, expect, test } from "bun:test";
import type { AgentEvent, SessionEntry } from "@musepi/pi-wire";
import { MaterializedView } from "./materialized-view";

function userMsg(ts: number, text = `m${ts}`): AgentEvent {
	return {
		type: "message_start",
		message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
	};
}

function oldEntries(ids: string[], baseTs = 1): SessionEntry[] {
	return ids.map((id, i) => ({
		type: "message" as const,
		id,
		parentId: null,
		timestamp: new Date(baseTs + i).toISOString(),
		message: { role: "user" as const, content: id, timestamp: baseTs + i },
	}));
}

describe("MaterializedView lazy backfill", () => {
	test("prependEntries inserts older entries at the head, newest-first preserved", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		for (let i = 1; i <= 5; i++) view.apply(userMsg(1000 + i)); // m1..m5

		view.prependEntries(oldEntries(["old-3", "old-2", "old-1"], 1));

		const entries = view.snapshot().entries;
		expect(entries.length).toBe(8);
		expect(entries.map(e => (e.type === "message" ? e.id : "")).join(",")).toBe(
			"old-3,old-2,old-1,user:1001,user:1002,user:1003,user:1004,user:1005",
		);
	});

	test("prepended messages are upsertable by the stream (re-keyed)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		for (let i = 1; i <= 3; i++) view.apply(userMsg(1000 + i));
		view.prependEntries(oldEntries(["old-1"], 1));

		// A streamed update to the prepended message replaces it in place
		// (new object reference, same position) — the row re-renders.
		const update: AgentEvent = {
			type: "message_update",
			message: { role: "user", content: "updated", timestamp: 1 },
		};
		view.apply(update);

		const entries = view.snapshot().entries;
		expect(entries.length).toBe(4); // no duplicate
		const first = entries[0];
		expect(first.type).toBe("message");
		if (first.type === "message") {
			// first.message 是 WireMessage 联合(含无 content 的 BashExecutionMessage),
			// 取 content 需显式收窄到有 content 的成员形状。
			expect((first.message as { content?: unknown }).content).toBe("updated");
		}
	});

	test("empty prepend is a no-op", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(1));
		view.prependEntries([]);
		expect(view.snapshot().entries.length).toBe(1);
	});
});

describe("MaterializedView parentId 保留(/tree 消息树数据契约)", () => {
	test("message 携带 parentId 时投影保留(向前兼容 live 发射端打标)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		// 模拟未来 live 发射端打标:message 自带 parentId(父 = 上一条消息)。
		view.apply({
			type: "message_start",
			message: { role: "user", content: "第一问", timestamp: 1 },
		});
		view.apply({
			type: "message_start",
			message: { role: "user", content: "追问", timestamp: 2, parentId: "user:1" },
		});
		const entries = view.snapshot().entries;
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ id: "user:1", parentId: null });
		expect(entries[1]).toMatchObject({ id: "user:2", parentId: "user:1" });
	});

	test("message 无 parentId 时退化为 null(当前 live 事件行为不变)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply({ type: "message_start", message: { role: "user", content: "x", timestamp: 5 } });
		expect(view.snapshot().entries[0]).toMatchObject({ parentId: null });
	});

	test("从快照恢复保留既有 parentId(历史/持久化路径)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		for (let i = 1; i <= 2; i++) view.apply(userMsg(i));
		const snap = view.snapshot();

		// 老版 transcript/历史快照的 entries 自带 parentId。
		const old = snap.entries.map((e, i) => ({
			...e,
			id: `msg-${i + 1}`,
			parentId: i === 0 ? null : `msg-${i}`,
		}));
		const restored = MaterializedView.fromSnapshot("s1", "/tmp", { ...snap, entries: old });
		expect(restored?.snapshot().entries.map(e => e.parentId)).toEqual([null, "msg-1"]);
	});
});
