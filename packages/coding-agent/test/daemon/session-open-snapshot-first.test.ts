/**
 * 会话打开路径（P0-6，docs/review/0.5.1-defect-handoff.md）。
 *
 * 契约：桌面打开路径走 session.resume，一次请求拿到快照与实时流凭证。
 * 快照先返回，附着在响应之后（catchupIfNeeded）——live 会话直接订阅，
 * 历史会话先按需激活再订阅，因为打开后的 live 状态 RPC（thinkingInfo /
 * contextUsage / pauseStatus / modes）都以激活为前提；不激活则聊天面只有
 * 快照、没有 live，状态面板与后续操作都是空壳。MAX_LIVE_SESSIONS 与空闲
 * 回收仍由 session-host 的 LRU 上限负责，打开不是绕过它们的旁路。
 *
 * 失败模式（旧实现）：打开路径先试 session.subscribe——它内部无条件
 * activate，且响应体里没有快照，客户端要再发一次 session.snapshot；
 * 两次请求之间的增量帧会丢，历史会话被重复激活。
 */
import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

function captureConn(id: string): DaemonConnection {
	return {
		id,
		writableLength: () => 0,
		send: () => {},
	} as unknown as DaemonConnection;
}

interface HostRecorder {
	host: DaemonSessionHost;
	calls: { activate: string[]; subscribe: [string, string][]; sends: unknown[] };
}

function makeHost(opts: { live?: Record<string, Record<string, unknown>> }): HostRecorder {
	const liveById = new Map(Object.entries(opts.live ?? {}));
	const calls: HostRecorder["calls"] = { activate: [], subscribe: [], sends: [] };
	const host = {
		cwd: () => "/tmp",
		snapshot: async (sessionId: string) => ({ entries: [{ id: `e-${sessionId}` }], cursor: 7 }),
		get: (sessionId: string) => liveById.get(sessionId),
		activate: async (sessionId: string) => {
			calls.activate.push(sessionId);
			const live = { sessionId, autoTitle: false, agentSession: { sendUserMessage: async () => {} } };
			liveById.set(sessionId, live);
			return live;
		},
		checkpointSeq: async () => 0,
		catchup: async () => {},
		touch: () => {},
		subscribe: async (sessionId: string, conn: DaemonConnection) => {
			calls.subscribe.push([sessionId, conn.id]);
		},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return { host, calls };
}

describe("snapshot-first session open (P0-6)", () => {
	test("resume on a history session activates it once and attaches after the response", async () => {
		const { host, calls } = makeHost({});
		const server = new DaemonServer(host);
		const conn = captureConn("conn-view");

		const res = (await server.handle("session.resume", { sessionId: "sess-hist" }, conn)) as {
			stream: string | null;
			snapshot: Record<string, unknown>;
		};

		// Snapshot served (with tail-window parity from tailSnapshot)…
		expect(res.stream).toBe("conn-view");
		expect(res.snapshot.entries).toEqual([{ id: "e-sess-hist" }]);
		expect(res.snapshot.tail).toEqual({ hasMore: false, beforeId: null });
		// …activation happens exactly once, and the stream attaches after the response.
		expect(calls.activate).toEqual(["sess-hist"]);
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-hist" }, conn);
		expect(calls.subscribe).toEqual([["sess-hist", "conn-view"]]);
		// A freshly activated session has no stream-only visuals to hydrate yet.
		expect("activeTools" in res.snapshot).toBe(false);
		expect("agentsProgress" in res.snapshot).toBe(false);
	});

	test("resume on a live session still attaches the connection after the response", async () => {
		const live = {
			sessionId: "sess-live",
			autoTitle: true,
			activeToolCalls: new Map([["t1", { toolCallId: "t1" }]]),
			subagentProgress: new Map([["a1", { agentId: "a1" }]]),
		};
		const { host, calls } = makeHost({ live: { "sess-live": live } });
		const server = new DaemonServer(host);
		const conn = captureConn("conn-view");

		const res = (await server.handle("session.resume", { sessionId: "sess-live" }, conn)) as {
			stream: string | null;
			snapshot: Record<string, unknown>;
		};

		expect(res.stream).toBe("conn-view");
		// Live hydration rides the snapshot (subscribe-route dock/swarm parity).
		expect(res.snapshot.activeTools).toEqual([{ toolCallId: "t1" }]);
		expect(res.snapshot.agentsProgress).toEqual([{ agentId: "a1" }]);
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-live" }, conn);
		expect(calls.subscribe).toEqual([["sess-live", "conn-view"]]);
		// Live sessions were never activated by an open — they already were.
		expect(calls.activate).toEqual([]);
	});

	test("session.send on a non-live session activates and attaches the sender (on-demand activation)", async () => {
		const { host, calls } = makeHost({});
		const server = new DaemonServer(host);
		const conn = captureConn("conn-send");

		const res = (await server.handle("session.send", { sessionId: "sess-hist", text: "hello" }, conn)) as {
			accepted: boolean;
		};

		expect(res.accepted).toBe(true);
		expect(calls.activate).toEqual(["sess-hist"]);
		// The sender is attached BEFORE the turn starts, so turn events reach
		// the GUI (the comment contract in the session.send route).
		expect(calls.subscribe).toEqual([["sess-hist", "conn-send"]]);
	});
});
