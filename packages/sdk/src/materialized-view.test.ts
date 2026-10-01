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

	test("prepended page overlapping already-held ids (duplicate journal ids) dedupes instead of double-inserting", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		for (let i = 1; i <= 3; i++) view.apply(userMsg(1000 + i));
		// Ambiguous beforeId boundary (findIndex hit an earlier duplicate):
		// the page re-includes entries the view already holds.
		view.prependEntries(oldEntries(["old-2", "user:1001", "user:1002"], 1));

		const entries = view.snapshot().entries;
		expect(entries.length).toBe(4); // old-2 added, 2 duplicates dropped
		expect(entries.map(e => (e.type === "message" ? e.id : "")).join(",")).toBe(
			"old-2,user:1001,user:1002,user:1003",
		);
	});

	test("fully-overlapping prepend is a no-op (does not corrupt the cursor state)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		for (let i = 1; i <= 2; i++) view.apply(userMsg(1000 + i));
		view.prependEntries(oldEntries(["user:1001", "user:1002"], 1));
		expect(view.snapshot().entries.length).toBe(2);
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

describe("MaterializedView custom-role message projection", () => {
	// The wire AgentEvent type declares provider message roles only, yet the
	// daemon forwards custom messages (advisor cards, async results, IRC relay)
	// on the same message_* seam — the projection is the boundary that has to
	// tolerate the wider runtime shape.
	function messageEvent(type: "message_start" | "message_end", message: unknown): AgentEvent {
		return { type, message } as unknown as AgentEvent;
	}

	function advisorMessage(timestamp: number): unknown {
		return {
			role: "custom",
			customType: "advisor",
			content: '<advisory severity="nit">prefer a smaller diff</advisory>',
			display: true,
			details: { notes: [{ note: "prefer a smaller diff", severity: "nit" }] },
			attribution: "agent",
			timestamp,
		};
	}

	test("a custom-role message_* pair projects into one custom_message entry", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		const message = advisorMessage(1000);
		view.apply(messageEvent("message_start", message));
		view.apply(messageEvent("message_end", message));

		const entries = view.snapshot().entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "custom_message",
			id: "custom:1000",
			parentId: null,
			customType: "advisor",
			display: true,
			details: { notes: [{ note: "prefer a smaller diff", severity: "nit" }] },
		});
	});

	test("hookMessage rides the same projection", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(
			messageEvent("message_end", {
				role: "hookMessage",
				customType: "hook:notice",
				content: "noticed",
				display: true,
				timestamp: 7,
			}),
		);

		expect(view.snapshot().entries[0]).toMatchObject({
			type: "custom_message",
			customType: "hook:notice",
			content: "noticed",
		});
	});

	test("provider messages still project into message entries", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(9));
		expect(view.snapshot().entries[0]).toMatchObject({ type: "message", id: "user:9" });
	});

	test("an IRC record announced and injected renders as one card", () => {
		// irc-bridge both announces the record (irc_message) and queues it as an
		// aside, whose injection emits message_start/end for the same record.
		const record = {
			role: "custom",
			customType: "irc:incoming",
			content: "sub: 我查一下",
			display: true,
			details: { from: "sub", message: "我查一下" },
			timestamp: 1700000100000,
		};
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply({ type: "irc_message", message: record } as AgentEvent);
		view.apply(messageEvent("message_start", record));
		view.apply(messageEvent("message_end", record));

		const entries = view.snapshot().entries;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ type: "custom_message", customType: "irc:incoming" });
	});

	test("a live-stamped parentId on a custom-role message is preserved", () => {
		// Contract the GUI tree relies on: when the daemon stamps parentId on
		// the wire message (custom roles included), the projected custom entry
		// keeps it, so the advisor card links into the entry tree instead of
		// dangling as a fake root (which hid every earlier message).
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(messageEvent("message_start", { role: "user", content: "hi", timestamp: 1 }));
		view.apply(
			messageEvent("message_end", {
				role: "custom",
				customType: "advisor",
				content: "<advisory/>",
				display: true,
				timestamp: 2,
				parentId: "user:1",
			}),
		);
		expect(view.snapshot().entries[1]).toMatchObject({ type: "custom_message", id: "custom:2", parentId: "user:1" });
	});

	test("two different custom notes on the same timestamp keep both cards", () => {
		// messageKey is "custom:<ts>": a same-ms collision must not let the
		// second note overwrite the first card.
		const view = MaterializedView.replay("s1", "/tmp", []);
		const a = { role: "custom", customType: "advisor", content: "note A", display: true, timestamp: 100 };
		const b = { role: "custom", customType: "advisor", content: "note B", display: true, timestamp: 100 };
		view.apply(messageEvent("message_end", a));
		view.apply(messageEvent("message_end", b));
		const entries = view.snapshot().entries;
		expect(entries).toHaveLength(2);
		expect(entries.map(e => (e as { content?: string }).content)).toEqual(["note A", "note B"]);
	});
});

describe("MaterializedView round durations (agent_end freeze)", () => {
	function messageEvent(type: "message_start" | "message_end", message: unknown): AgentEvent {
		return { type, message } as unknown as AgentEvent;
	}
	function advisorMsg(ts: number): unknown {
		return {
			role: "custom",
			customType: "advisor",
			content: "<advisory/>",
			display: true,
			details: { notes: [{ note: "n" }] },
			timestamp: ts,
		};
	}

	test("advisor-spawned turn anchors the duration at the advisor note, not the stale user message", () => {
		// Contract: an agent-initiated (advisor) turn has no user message; its
		// round total must key on the advisor note ts and span only that turn.
		// Old behavior keyed on the last user message (hours ago) and required
		// an assistant message, so the GUI showed idle time as round time.
		const now = Date.now();
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(now - 3 * 3600_000)); // user turn 3h ago
		view.apply(messageEvent("message_end", advisorMsg(now - 4000)));
		view.apply({ type: "agent_end" } as AgentEvent);

		const pairs = view.snapshot().roundDurations ?? [];
		expect(pairs).toHaveLength(1);
		expect(pairs[0]![0]).toBe(now - 4000);
		// Single-entry round: last event IS the anchor → 0, never wall clock.
		expect(pairs[0]![1]).toBe(0);
	});

	test("a user turn ending after a later advisor note anchors at the advisor note", () => {
		// The anchor is the CURRENT turn start (last isTurnStart entry), not
		// the first/last user message of the session.
		const now = Date.now();
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(now - 10_000));
		view.apply(
			messageEvent("message_start", {
				role: "assistant",
				content: [{ type: "text", text: "a" }],
				timestamp: now - 9000,
			}),
		);
		view.apply(messageEvent("message_end", advisorMsg(now - 3000)));
		view.apply(messageEvent("message_end", { role: "assistant", content: [], timestamp: now - 500 }));
		view.apply({ type: "agent_end" } as AgentEvent);

		const pairs = view.snapshot().roundDurations ?? [];
		expect(pairs).toHaveLength(1);
		expect(pairs[0]![0]).toBe(now - 3000);
		expect(pairs[0]![1]).toBe(2500);
	});

	test("round total = last event ts − turn-start ts in event clock, immune to wall-clock lag", () => {
		// Contract: the frozen duration is computed purely from entry
		// timestamps (wire message clock). Timestamps an hour in the past
		// prove no Date.now() is read: wall-clock math would return ~1h,
		// the event span is exactly 47s.
		const t0 = Date.now() - 3600_000;
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(t0, "start"));
		view.apply(messageEvent("message_end", { role: "assistant", content: [], timestamp: t0 + 30_000 }));
		view.apply(messageEvent("message_end", { role: "assistant", content: [], timestamp: t0 + 47_000 }));
		view.apply({ type: "agent_end" } as AgentEvent);

		const pairs = view.snapshot().roundDurations ?? [];
		expect(pairs).toEqual([[t0, 47_000]]);
	});

	test("a round whose events predate the anchor (clock skew) records no total", () => {
		const t0 = Date.now();
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(t0));
		// A late-arriving older event becomes the last entry but predates
		// the turn-start anchor — a negative total must not be frozen.
		view.apply(messageEvent("message_end", { role: "assistant", content: [], timestamp: t0 - 5000 }));
		view.apply({ type: "agent_end" } as AgentEvent);

		expect(view.snapshot().roundDurations ?? []).toHaveLength(0);
	});
});

describe("MaterializedView structureRev / snapshot reference suppression (P1-12)", () => {
	// 失败模式:GUI 在流式 token 帧内重跑全部 O(n) 拓扑派生(分支索引、
	// 叶子链、画布导航条、消息树),长会话每帧 ≥5 次全量遍历;topology
	// memo 若挂在 entries 引用上,引用抑制又会冻住流式行更新。
	test("content upsert bumps entriesRev but NOT structureRev; snapshot emits a fresh array carrying the new entry object", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(1000, "第一帧"));
		const revBefore = view.snapshot().structureRev;

		// 同一 key 的内容 upsert(message_update 流式帧):id/parentId 不变。
		view.apply({ type: "message_update", message: { role: "user", content: "第二帧", timestamp: 1000 } });

		const snap = view.snapshot();
		expect(snap.structureRev).toBe(revBefore);
		const entry = snap.entries[0];
		expect(entry.type).toBe("message");
		if (entry.type === "message") {
			expect((entry.message as { content?: unknown }).content).toBe("第二帧");
		}
	});

	test("new message push bumps BOTH revisions", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(1000));
		const before = view.snapshot().structureRev ?? 0;
		view.apply(userMsg(2000));
		const snap = view.snapshot();
		expect(snap.structureRev).toBe(before + 1);
		expect(snap.entries.map(e => e.id).join(",")).toBe("user:1000,user:2000");
	});

	test("prependEntries bumps both revisions (list shape changed)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(1000));
		const before = view.snapshot().structureRev ?? 0;
		view.prependEntries(oldEntries(["old-1"], 1));
		const snap = view.snapshot();
		expect(snap.structureRev).toBe(before + 1);
		expect(snap.entries[0]?.id).toBe("old-1");
	});

	test("frames that touch no entry (turn_start/agent lifecycle) reuse the snapshot entries reference", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(1000));
		const first = view.snapshot();
		const ref = first.entries;

		view.apply({ type: "turn_start" } as AgentEvent);
		view.apply({ type: "agent_start" } as AgentEvent);
		view.apply({ type: "agent_end" } as AgentEvent);

		const second = view.snapshot();
		// 引用抑制:非内容帧必须拿到同一数组引用,GUI memo 层才不抖动。
		expect(second.entries).toBe(ref);
		expect(second.cursor).toBe(first.cursor + 3);
	});

	test("roundDurations array is reference-stable until a round completes", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		const t0 = Date.now();
		view.apply(userMsg(t0));
		view.apply({
			type: "message_end",
			message: { role: "assistant", content: [], timestamp: t0 + 1000 },
		} as unknown as AgentEvent);
		view.apply({ type: "agent_end" } as AgentEvent);
		const withRound = view.snapshot();
		expect(withRound.roundDurations).toHaveLength(1);

		// 后续非 round 帧复用同一引用。
		view.apply({ type: "turn_start" } as AgentEvent);
		expect(view.snapshot().roundDurations).toBe(withRound.roundDurations);
	});

	test("snapshot round-trips through fromSnapshot (old persisted snapshots without structureRev stay loadable)", () => {
		const view = MaterializedView.replay("s1", "/tmp", []);
		view.apply(userMsg(1000));
		const snap = view.snapshot();

		// 模拟旧版本持久化:没有 structureRev 字段。
		const legacy = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
		delete legacy.structureRev;
		const restored = MaterializedView.fromSnapshot("s1", "/tmp", legacy);
		expect(restored).not.toBeNull();
		// 恢复后的视图照常工作:新 push 仍 bump 两个版本号。
		restored?.apply(userMsg(2000));
		const restoredSnap = restored?.snapshot();
		expect(restoredSnap?.entries.map(e => e.id).join(",")).toBe("user:1000,user:2000");
		expect(typeof restoredSnap?.structureRev).toBe("number");
	});
});
