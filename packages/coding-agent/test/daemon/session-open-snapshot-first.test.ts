/**
 * 快照优先的会话打开路径（P0-6，docs/review/0.5.1-defect-handoff.md）。
 *
 * 钉死的契约：桌面打开路径走 session.resume——live 会话照常附着实时流，
 * 历史会话只拿只读快照，绝不创建 AgentSession / 加载 MCP / 跑 discovery
 * （MAX_LIVE_SESSIONS=8 与空闲回收因此重新生效）；激活只发生在显式写
 * 操作（session.send / session.branchAt 一族）。
 *
 * 失败模式（旧实现）：打开路径先试 session.subscribe——它内部无条件
 * activate，于是每点开一个历史会话都拉起完整 AgentSession + MCP +
 * discovery，「历史会话只读快照、按需激活」的设计成死代码，live 上限
 * 被穿透，闲置会话永不回收。
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
	test("resume on a history (non-live) session returns the snapshot WITHOUT activating or attaching", async () => {
		const { host, calls } = makeHost({});
		const server = new DaemonServer(host);
		const conn = captureConn("conn-view");

		const res = (await server.handle("session.resume", { sessionId: "sess-hist" }, conn)) as {
			stream: string | null;
			snapshot: Record<string, unknown>;
		};

		// Snapshot served (with tail-window parity from tailSnapshot)…
		expect(res.stream).toBeNull();
		expect(res.snapshot.entries).toEqual([{ id: "e-sess-hist" }]);
		expect(res.snapshot.tail).toEqual({ hasMore: false, beforeId: null });
		// …and the acceptance contract: no AgentSession spin-up, no stream attach.
		expect(calls.activate).toEqual([]);
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-hist" }, conn);
		expect(calls.subscribe).toEqual([]);
		// Negative contract: no live-only hydration keys on a history snapshot.
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
