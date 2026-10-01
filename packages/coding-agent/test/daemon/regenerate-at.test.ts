import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * `session.regenerateAt` — 重试(重新生成)某条 assistant 回复。
 *
 * 消费方可观察契约(GUI transcript ↻ 按钮,用户报告 2026-10-01):
 *  1. 旧的重试路径走 session.branchAt + 重发产生该回复的 USER 消息 ——
 *     模型上下文里多出一条重复的用户轮,轮次计数虚增。regenerateAt 必须
 *     直接把「解析后的 SDK id」交给 agentSession.regenerateAt(叶子落到
 *     回复的父节点 + 原地在途续跑,不重发用户文本)。
 *  2. 叶子移动与 branchAt 同一广播契约:订阅端只从事件流学习,没有
 *     session_leaf_moved 就永远停在旧 active path —— 重试后界面必须
 *     收到新的 leaf/path/pathEntries。
 *  3. regenerateAt 返回 false(在途/压缩中/目标不是 assistant)= 操作
 *     未发生:RPC 回 { ok: false } 且不得广播 leaf_moved(订阅端路径
 *     未被移动,广播会把客户端锚到错误分支)。
 *  4. 未知 messageId 走与 branchAt 相同的解析错误(共享 #resolveViewMessageId)。
 */
interface StubEntry {
	id: string;
	type?: string;
	parentId?: string | null;
	message?: { role?: string; content?: unknown; timestamp?: number; toolCallId?: string };
}

function stubHost(options: {
	entries: StubEntry[];
	leafEntry: StubEntry | undefined;
	regenerateAt: (targetId: string) => Promise<boolean>;
	onPublished: (event: unknown) => void;
}): DaemonSessionHost {
	return {
		cwd: () => "/tmp",
		get: () => ({
			agentSession: {
				sessionManager: {
					getEntries: () => options.entries,
					getLeafEntry: () => options.leafEntry,
				},
				regenerateAt: options.regenerateAt,
			},
			publishWireEvent: options.onPublished,
		}),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
}

function conn(): DaemonConnection {
	return {
		id: "regen-test",
		writableLength: () => 0,
		send: () => {},
	} as unknown as DaemonConnection;
}

// 两轮流会话:重试第二轮的 assistant 回复 → 叶子应落回 a1(u2 的父)。
const ENTRIES: StubEntry[] = [
	{ id: "u1", type: "message", parentId: null, message: { role: "user", timestamp: 1, content: "q1" } },
	{ id: "a1", type: "message", parentId: "u1", message: { role: "assistant", timestamp: 2, content: "a1" } },
	{ id: "u2", type: "message", parentId: "a1", message: { role: "user", timestamp: 3, content: "q2" } },
	{ id: "a2", type: "message", parentId: "u2", message: { role: "assistant", timestamp: 4, content: "a2" } },
];
const LEAF = ENTRIES[3];

describe("session.regenerateAt", () => {
	test("resolves the view key to the SDK id and delegates to agentSession.regenerateAt", async () => {
		const seen: string[] = [];
		const server = new DaemonServer(
			stubHost({
				entries: ENTRIES,
				leafEntry: LEAF,
				regenerateAt: async targetId => {
					seen.push(targetId);
					return true;
				},
				onPublished: () => {},
			}),
		);
		const res = (await server.handle(
			"session.regenerateAt",
			{ sessionId: "s1", messageId: "assistant:4" },
			conn(),
		)) as { ok?: boolean; leafId?: string | null; path?: string[] };
		// 视图键 "assistant:4" 必须解析成 SDK 条目 id "a2",而不是原样透传。
		expect(seen).toEqual(["a2"]);
		expect(res.ok).toBe(true);
		expect(res.leafId).toBe("assistant:4");
		expect(res.path).toEqual(["user:1", "assistant:2", "user:3", "assistant:4"]);
	});

	test("publishes session_leaf_moved so subscribers re-anchor onto the truncated path", async () => {
		const published: unknown[] = [];
		const server = new DaemonServer(
			stubHost({
				entries: ENTRIES,
				leafEntry: LEAF,
				regenerateAt: async () => true,
				onPublished: e => published.push(e),
			}),
		);
		await server.handle("session.regenerateAt", { sessionId: "s1", messageId: "a2" }, conn());
		expect(published).toHaveLength(1);
		const event = published[0] as { type?: string; leafId?: string | null; path?: string[] };
		expect(event.type).toBe("session_leaf_moved");
		expect(event.leafId).toBe("assistant:4");
		expect(Array.isArray(event.path)).toBe(true);
	});

	test("agent busy / not an assistant target → { ok: false } and NO leaf_moved broadcast", async () => {
		const published: unknown[] = [];
		const server = new DaemonServer(
			stubHost({
				entries: ENTRIES,
				leafEntry: LEAF,
				regenerateAt: async () => false,
				onPublished: e => published.push(e),
			}),
		);
		const res = (await server.handle(
			"session.regenerateAt",
			{ sessionId: "s1", messageId: "assistant:4" },
			conn(),
		)) as { ok?: boolean };
		expect(res.ok).toBe(false);
		// 叶子没有移动,广播会把订阅端锚到错误的 active path —— 必须静默。
		expect(published).toHaveLength(0);
	});

	test("unknown messageId → same resolution error as session.branchAt", async () => {
		const server = new DaemonServer(
			stubHost({
				entries: ENTRIES,
				leafEntry: LEAF,
				regenerateAt: async () => true,
				onPublished: () => {},
			}),
		);
		expect(
			server.handle("session.regenerateAt", { sessionId: "s1", messageId: "assistant:999" }, conn()),
		).rejects.toThrow("Unknown message");
	});
});
