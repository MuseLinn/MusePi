import { describe, expect, it } from "bun:test";
import { GuiSessionStore } from "../src/lib/session-store";

// 乐观回显契约(TUI startPendingSubmission parity):GUI 发送后立即本地
// 插入用户消息,不等 daemon 事件流回推——否则 reactivate 历史会话 /
// agent 思考准备慢时,输入框已清空但气泡要等 message_start 才出现。

function store(): GuiSessionStore {
	return new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
}

/** apply 的 streaming 事件是 frame-coalesced(queueMicrotask flush)。 */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function userMessageStart(text: string): StreamEventShape {
	return {
		kind: "event",
		seq: 1,
		payload: {
			type: "message_start",
			message: { role: "user", timestamp: Date.now(), content: [{ type: "text", text }] },
		},
	};
}

function agentEnd(): StreamEventShape {
	return {
		kind: "event",
		seq: 2,
		payload: { type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn" }] },
	};
}

interface StreamEventShape {
	kind: string;
	seq: number;
	payload: unknown;
}

describe("乐观回显", () => {
	it("optimisticEcho 后 entries 尾部出现本地 user 条目", () => {
		const s = store();
		s.optimisticEcho("hello");
		const snap = s.getSnapshot();
		const last = snap.entries[snap.entries.length - 1] as { type?: string; message?: { role?: string } };
		expect(last.type).toBe("message");
		expect(last.message?.role).toBe("user");
	});

	it("daemon 同签名 message_start 到达 → 乐观条目移除,权威条目接管(无重复)", async () => {
		const s = store();
		s.optimisticEcho("hello");
		// 乐观条目在,权威条目还没来。
		expect(s.getSnapshot().entries).toHaveLength(1);
		// daemon 回推同文本 user 消息。
		s.apply(userMessageStart("hello"));
		await settle();
		const snap = s.getSnapshot();
		// 只有权威条目(乐观条目已清除,不重复)。
		expect(snap.entries).toHaveLength(1);
		const entry = snap.entries[0] as { id?: string; message?: { content?: unknown } };
		expect(entry.id).not.toContain("optimistic");
	});

	it("不同签名 message_start 不误删乐观条目", async () => {
		const s = store();
		s.optimisticEcho("hello");
		// daemon 回推的是别的消息(历史/他处)。
		s.apply(userMessageStart("different message"));
		await settle();
		// 乐观条目仍在。
		const snap = s.getSnapshot();
		const last = snap.entries[snap.entries.length - 1] as { id?: string };
		expect(last.id).toContain("optimistic");
	});

	it("agent_end 仍未匹配 → 乐观条目清空(防幽灵)", async () => {
		const s = store();
		s.optimisticEcho("hello");
		// run 结束但 daemon 从未回推该 user 消息(发送被吞/失败)。
		s.apply(agentEnd());
		await settle();
		const snap = s.getSnapshot();
		expect(snap.entries.some(e => (e as { id?: string }).id?.includes("optimistic"))).toBe(false);
	});

	it("图片消息也按签名匹配(文本+图片数)", async () => {
		const s = store();
		s.optimisticEcho("看图", [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		// daemon 回推同文本同图片数。
		s.apply({
			kind: "event",
			seq: 1,
			payload: {
				type: "message_start",
				message: {
					role: "user",
					timestamp: Date.now(),
					content: [
						{ type: "text", text: "看图" },
						{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					],
				},
			},
		});
		await settle();
		const snap = s.getSnapshot();
		expect(snap.entries.some(e => (e as { id?: string }).id?.includes("optimistic"))).toBe(false);
	});
});
