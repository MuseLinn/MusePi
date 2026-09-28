/**
 * SessionService（P2 首个 cordis 化 L2 服务，ADR 0001）契约测试。
 *
 * 钉死的契约（客户端 tree 接口的行为面）：
 *  1. tree：父子挂接（parentId → children，孤儿入 roots）、label 60 字
 *     截断、空标题不挂 label、cron 节点带 source 标注、updatedAt/timestamp
 *     ISO 化、autoTitle=false 的会话不落 firstUserMessage 兜底；
 *  2. resume：stream = 发起连接的 id（live 存在时）/ null；resumeLive
 *     登记写半被调用（值 = live 引用）；cursor 早于压缩检查点时
 *     compactedThrough = true；
 *  3. 服务经 DaemonHostContext 挂载后 ctx 可解析（cordis 化 parity）。
 */
import { describe, expect, it } from "bun:test";
import { DaemonHostContext } from "../host-context";
import { SessionService, type SessionServiceDeps, type SessionTreeRow } from "./session-service";

function row(overrides: Partial<SessionTreeRow> = {}): SessionTreeRow {
	return {
		sessionId: "s1",
		parentId: null,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_100_000,
		...overrides,
	};
}

function deps(overrides: Partial<SessionServiceDeps> = {}): SessionServiceDeps {
	return {
		knownSessions: async () => [],
		snapshot: async () => ({ entries: [] }),
		checkpointSeq: async () => 0,
		setResumeLive: () => {},
		resolveLive: () => undefined,
		cronSessionIds: () => new Set(),
		firstUserMessage: () => "",
		...overrides,
	};
}

describe("SessionService (P2 cordis 化首服务)", () => {
	it("tree: parent/child attachment and roots for orphans", async () => {
		const svc = new SessionService(
			deps({
				knownSessions: async () => [
					row({ sessionId: "parent" }),
					row({ sessionId: "child", parentId: "parent" }),
					row({ sessionId: "orphan" }),
				],
			}),
		);
		const roots = (await svc.tree()) as { entry: { id: string }; children: { entry: { id: string } }[] }[];
		expect(roots.map(r => r.entry.id)).toEqual(["parent", "orphan"]);
		expect(roots[0].children.map(c => c.entry.id)).toEqual(["child"]);
	});

	it("tree: label truncation at 60 chars, empty title omits label", async () => {
		const longTitle = "x".repeat(61);
		const svc = new SessionService(
			deps({
				knownSessions: async () => [row({ sessionId: "a", title: longTitle }), row({ sessionId: "b", title: "" })],
			}),
		);
		const roots = (await svc.tree()) as { entry: { id: string; label?: string } }[];
		expect(roots[0].entry.label).toBe(`${"x".repeat(60)}…`);
		expect(roots[1].entry.label).toBeUndefined();
	});

	it("tree: cron sessions carry source=cron; firstUserMessage fallback only when autoTitle !== false", async () => {
		const calls: string[] = [];
		const svc = new SessionService(
			deps({
				knownSessions: async () => [
					row({ sessionId: "cron-child", parentId: "p", title: "cron-title" }),
					row({ sessionId: "auto", parentId: "p" }),
					row({ sessionId: "no-auto", parentId: "p" }),
					row({ sessionId: "p", title: "root" }),
				],
				cronSessionIds: () => new Set(["cron-child"]),
				resolveLive: sessionId => (sessionId === "no-auto" ? { autoTitle: false } : undefined),
				firstUserMessage: sessionId => {
					calls.push(sessionId);
					return `title-${sessionId}`;
				},
			}),
		);
		const roots = (await svc.tree()) as {
			children: { entry: { id: string; label?: string; source?: string } }[];
		}[];
		const children = roots[0].children;
		const cronNode = children.find(c => c.entry.id === "cron-child");
		expect(cronNode?.entry.source).toBe("cron");
		expect(children.find(c => c.entry.id === "auto")?.entry.label).toBe("title-auto");
		expect(children.find(c => c.entry.id === "no-auto")?.entry.label).toBeUndefined();
		// Failure mode: autoTitle=false 的会话走了兜底标题 → 设置项「自动生成
		// 会话标题」关闭被静默无视。
		expect(calls).toEqual(["auto"]);
	});

	it("resume: stream is the requesting connection id; resumeLive write-half receives the live handle", async () => {
		const live = { autoTitle: true };
		let registered: unknown = "unset";
		const svc = new SessionService(
			deps({
				snapshot: async () => ({ entries: [{ seq: 1 }] }),
				checkpointSeq: async () => 5,
				resolveLive: () => live,
				setResumeLive: l => {
					registered = l;
				},
			}),
		);
		const r = await svc.resume({ sessionId: "s1" }, { id: "conn-7" });
		expect(r.stream).toBe("conn-7");
		expect(registered).toBe(live);
		expect(r.compactedThrough).toBe(false);
	});

	it("resume: compactedThrough when requested cursor predates the compaction checkpoint", async () => {
		const svc = new SessionService(
			deps({
				checkpointSeq: async () => 5,
				resolveLive: () => undefined,
			}),
		);
		expect((await svc.resume({ sessionId: "s1", cursor: 3 }, { id: "c" })).compactedThrough).toBe(true);
		expect((await svc.resume({ sessionId: "s1", cursor: 5 }, { id: "c" })).compactedThrough).toBe(false);
		// Failure mode: 边界读错（checkpointSeq > cursor 的严格大于被写成 >=）
		// → cursor 恰在检查点的客户端被误判为压缩穿透，白白全量刷新派生态。
	});

	it("service resolves from the cordis context after DaemonHostContext mount", async () => {
		const svc = new SessionService(deps());
		const host = new DaemonHostContext();
		await host.mount(svc);
		expect(host.get<SessionService>("session-tree")).toBe(svc);
		await host.dispose();
	});
});
