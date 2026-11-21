import { describe, expect, it } from "bun:test";
import { GuiSessionStore } from "../src/lib/session-store";

// 崩溃后的幻影工作态：daemon 在回合中途被杀，`agent_end` 永远不会到达，
// 重开会话拿到的快照可能仍带 isStreaming。`session.list` 的 working 才是
// daemon 的实时真值；adoptIdleState 用它清掉运行标志，且不编造任何条目。

function store(state?: { isStreaming?: boolean }): GuiSessionStore {
	return new GuiSessionStore("s1", { entries: [], cursor: 0, state: state as never }, "/tmp");
}

describe("adoptIdleState", () => {
	it("drops a working flag the daemon no longer reports", () => {
		const s = store({ isStreaming: true });
		expect(s.getSnapshot().working).toBe(true);
		s.adoptIdleState();
		expect(s.getSnapshot().working).toBe(false);
		// No entries are invented: the transcript is exactly what it was.
		expect(s.getSnapshot().entries).toHaveLength(0);
	});

	it("is a no-op for a session that was already idle", () => {
		const s = store({ isStreaming: false });
		let notified = 0;
		const off = s.subscribe(() => {
			notified += 1;
		});
		s.adoptIdleState();
		off();
		expect(s.getSnapshot().working).toBe(false);
		expect(notified).toBe(0);
	});

	it("does not touch the transcript or its watermark", () => {
		const s = new GuiSessionStore(
			"s1",
			{
				entries: [
					{
						type: "message",
						id: "u1",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: { role: "user", timestamp: Date.now(), content: [{ type: "text", text: "hi" }] },
					},
				] as never,
				cursor: 7,
				state: { isStreaming: true } as never,
			},
			"/tmp",
		);
		const before = s.getSnapshot();
		s.adoptIdleState();
		const after = s.getSnapshot();
		expect(after.entries).toHaveLength(before.entries.length);
		expect(after.watermark).toBe(before.watermark);
	});
});
