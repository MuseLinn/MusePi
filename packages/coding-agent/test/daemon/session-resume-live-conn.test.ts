/**
 * session.resume 的 resumeLive 登记按连接归属（P0-7，
 * docs/review/0.5.1-defect-handoff.md）。
 *
 * 钉死的契约：session.resume 在连接 X 上登记的 live 句柄，只能被同一连接
 * 的 catchupIfNeeded 消费——attach（host.subscribe）必须落在 (X 的会话, X)
 * 上。
 *
 * 失败模式（旧实现是 server 上单字段 #resumeLive）：桌面与 guest（或两个
 * 窗口）并发 resume 不同会话时，后写覆盖先写——连接 A 的 catchup 读到的是
 * 连接 B 刚 resume 的会话，A 被 attach 到 B 的实时流（帧再被客户端 sessionId
 * 守卫全丢，表现为「会话开着但永远收不到消息」），而 B 的 catchup 读到
 * null，订阅永远不发生。
 *
 * 复现的调度序（与 handleRpcLine 跨连接在 await 点交错一致）：
 *   A.resume → B.resume → A.catchup → B.catchup
 */
import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

function captureConn(id: string): { conn: DaemonConnection } {
	return {
		conn: {
			id,
			writableLength: () => 0,
			send: () => {},
		} as unknown as DaemonConnection,
	};
}

function makeHost(liveIds: string[]) {
	const liveById = new Map(liveIds.map(id => [id, { sessionId: id }]));
	const subscribed: [string, string][] = [];
	const caughtUp: [string, string][] = [];
	const host = {
		cwd: () => "/tmp",
		snapshot: async (sessionId: string) => ({ entries: [], header: { id: sessionId } }),
		get: (sessionId: string) => liveById.get(sessionId),
		checkpointSeq: async () => 0,
		catchup: async (sessionId: string, _cursor: number, conn: DaemonConnection) => {
			caughtUp.push([sessionId, conn.id]);
		},
		touch: () => {},
		subscribe: async (sessionId: string, conn: DaemonConnection) => {
			subscribed.push([sessionId, conn.id]);
		},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return { host, subscribed, caughtUp };
}

describe("resumeLive per-connection attribution (P0-7)", () => {
	test("interleaved resumes on two connections attach each conn to its own session", async () => {
		const { host, subscribed } = makeHost(["sess-a", "sess-b"]);
		const server = new DaemonServer(host);
		const { conn: connA } = captureConn("conn-a");
		const { conn: connB } = captureConn("conn-b");

		// The exact interleaving that cross-wired the old single shared field.
		await server.handle("session.resume", { sessionId: "sess-a" }, connA);
		await server.handle("session.resume", { sessionId: "sess-b" }, connB);
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-a" }, connA);
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-b" }, connB);

		expect(subscribed).toEqual([
			["sess-a", "conn-a"],
			["sess-b", "conn-b"],
		]);
	});

	test("catchup without a prior resume on that connection attaches nothing", async () => {
		const { host, subscribed } = makeHost(["sess-a"]);
		const server = new DaemonServer(host);
		const { conn } = captureConn("conn-x");
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-a" }, conn);
		expect(subscribed).toEqual([]);
	});

	test("resume of a non-live session leaves nothing pending", async () => {
		const { host, subscribed } = makeHost([]);
		const server = new DaemonServer(host);
		const { conn } = captureConn("conn-x");
		const result = (await server.handle("session.resume", { sessionId: "archived" }, conn)) as {
			stream: string | null;
		};
		expect(result.stream).toBeNull();
		await server.catchupIfNeeded("session.resume", { sessionId: "archived" }, conn);
		expect(subscribed).toEqual([]);
	});

	test("each resume consumes its own registration once (repeat catchup is a no-op)", async () => {
		const { host, subscribed } = makeHost(["sess-a"]);
		const server = new DaemonServer(host);
		const { conn } = captureConn("conn-a");
		await server.handle("session.resume", { sessionId: "sess-a" }, conn);
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-a" }, conn);
		await server.catchupIfNeeded("session.resume", { sessionId: "sess-a" }, conn);
		// Failure mode: 登记未被消费/清除 → 同连接下一次无关 catchup 重复
		// attach，客户端收到重复流帧。
		expect(subscribed).toEqual([["sess-a", "conn-a"]]);
	});
});
