/**
 * 轨迹增量派生契约(P1-11,docs/review/0.5.1-defect-handoff.md)。
 *
 * 失败模式:轨迹/地图视图挂在每帧换引用的 store 输出上,旧实现每帧对
 * 全量历史跑 buildTrajectoryTree 全量重算(mem-bench 级长会话下每帧
 * 数百 ms)。deriveTrajectoryTree 按对象身份找公共前缀、断点续派生,
 * 必须把流式帧的文本派生量钉死在「新增条目」上、与总条目数无关。
 *
 * 钉死的契约:
 *  ① probe.derivedEntries ——首调全量;流式追加只计新增;尾部替换
 *    (store upsert 语义)只计被替换位之后的片段;零变更帧不计;
 *  ② 输出共价 ——任意操作序列下 derive 与一次性 buildTrajectory 的
 *    事件/统计深度相等;
 *  ③ 引用稳定 ——零变更(新数组身份、同对象序列)返回上次结果引用,
 *    下游 memo 不失效;
 *  ④ 结构性失效 ——前插 / activePath 内容变化 / 输入收缩触发全量重派生。
 */
import { describe, expect, test } from "bun:test";
import { buildTrajectory, type TrajectoryEvent, type TrajectoryStats } from "../src/components/trajectory-data";
import {
	createTrajectoryDeriveCache,
	deriveTrajectory,
	deriveTrajectoryTree,
} from "../src/components/trajectory-derive";

let seq = 0;
function userEntry(text: string): unknown {
	seq += 1;
	return {
		id: `user:${seq}`,
		parentId: null,
		type: "message",
		timestamp: `2026-10-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

function assistantEntry(text: string, toolCalls: string[] = []): unknown {
	seq += 1;
	return {
		id: `assistant:${seq}`,
		parentId: null,
		type: "message",
		timestamp: `2026-10-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				...toolCalls.map(name => ({ type: "toolCall", id: `call-${name}-${seq}`, name, arguments: {} })),
			],
		},
	};
}

function expectEqualToOneShot(
	got: { events: TrajectoryEvent[]; stats: TrajectoryStats },
	entries: readonly unknown[],
	activePath?: ReadonlySet<string>,
) {
	const oneShot = buildTrajectory(entries, activePath);
	expect(got.events).toEqual(oneShot.events);
	expect(got.stats).toEqual(oneShot.stats);
}

describe("deriveTrajectory(P1-11 增量派生)", () => {
	test("流式追加:重算量 = 新增条目,与总条目无关(probe 钉死)", () => {
		const cache = createTrajectoryDeriveCache();
		const probe = { derivedEntries: 0 };
		const base: unknown[] = [];
		for (let i = 0; i < 200; i++) base.push(userEntry(`q${i}`), assistantEntry(`a${i}`, ["read"]));
		deriveTrajectory(base, undefined, cache, probe);
		expect(probe.derivedEntries).toBe(400); // 首调全量

		// 流式追加 3 条(新数组身份,同对象引用 + 新对象)——只重跑 3 条。
		const next = [...base, userEntry("q200"), assistantEntry("a200"), assistantEntry("a200b")];
		probe.derivedEntries = 0;
		const res = deriveTrajectory(next, undefined, cache, probe);
		expect(probe.derivedEntries).toBe(3);
		expectEqualToOneShot(res, next);

		// 再来 3 条 —— 仍然只计新增(总条目已到 406,与总数无关)。
		const next2 = [...next, userEntry("q201"), assistantEntry("a201", ["grep", "write"]), assistantEntry("tail")];
		probe.derivedEntries = 0;
		const res2 = deriveTrajectory(next2, undefined, cache, probe);
		expect(probe.derivedEntries).toBe(3);
		expectEqualToOneShot(res2, next2);
	});

	test("尾部替换(store upsert 语义):只重跑被替换的尾条目", () => {
		const cache = createTrajectoryDeriveCache();
		const probe = { derivedEntries: 0 };
		const base: unknown[] = [userEntry("q1"), assistantEntry("partial")];
		deriveTrajectory(base, undefined, cache, probe);

		// 流式帧:尾 assistant 条目被内容更全的新对象替换(同一 id 语义)。
		const last = base[base.length - 1] as { id: string };
		const replaced = [...base.slice(0, -1), { ...(base[base.length - 1] as object), id: last.id }];
		probe.derivedEntries = 0;
		const res = deriveTrajectory(replaced as unknown[], undefined, cache, probe);
		expect(probe.derivedEntries).toBe(1);
		expectEqualToOneShot(res, replaced);
	});

	test("零变更帧(新数组身份、同对象序列):probe 不计、结果引用稳定", () => {
		const cache = createTrajectoryDeriveCache();
		const probe = { derivedEntries: 0 };
		const base: unknown[] = [userEntry("q1"), assistantEntry("a1"), userEntry("q2")];
		const first = deriveTrajectory(base, undefined, cache, probe);
		probe.derivedEntries = 0;
		const again = deriveTrajectory([...base], undefined, cache, probe);
		expect(probe.derivedEntries).toBe(0);
		expect(again).toBe(first);
		expect(again.events).toBe(first.events);
	});

	test("activePath 内容变化 → 全量重派生;同内容新 Set 引用 → 零重算", () => {
		const cache = createTrajectoryDeriveCache();
		const probe = { derivedEntries: 0 };
		const base: unknown[] = [
			{ ...(userEntry("q1") as object), id: "u1" },
			{ ...(assistantEntry("a1") as object), id: "a1", parentId: "u1" },
			{ ...(userEntry("q2") as object), id: "u2", parentId: "a1" },
			{ ...(assistantEntry("a2") as object), id: "a2", parentId: "u2" },
		];
		const path1 = new Set(["u1", "a1", "u2", "a2"]);
		deriveTrajectory(base, path1, cache, probe);
		expect(probe.derivedEntries).toBe(4);

		// 同内容、新 Set 引用(GUI 每帧的实际情况)→ 零重算。
		probe.derivedEntries = 0;
		const same = deriveTrajectory(base, new Set(path1), cache, probe);
		expect(probe.derivedEntries).toBe(0);
		expectEqualToOneShot(same, base, path1);

		// 内容真变(切叶)→ 全量。
		probe.derivedEntries = 0;
		const path2 = new Set(["u1", "a2"]);
		const switched = deriveTrajectory(base, path2, cache, probe);
		expect(probe.derivedEntries).toBe(4);
		expectEqualToOneShot(switched, base, path2);
	});

	test("前插(历史分页)→ 全量重派生;输出与一次性共价", () => {
		const cache = createTrajectoryDeriveCache();
		const probe = { derivedEntries: 0 };
		const tail: unknown[] = [userEntry("q2"), assistantEntry("a2")];
		deriveTrajectory(tail, undefined, cache, probe);
		expect(probe.derivedEntries).toBe(2);

		const prepended: unknown[] = [userEntry("q0"), assistantEntry("a0"), ...tail];
		probe.derivedEntries = 0;
		const res = deriveTrajectory(prepended, undefined, cache, probe);
		expect(probe.derivedEntries).toBe(4); // 轮编号整体位移,无法复用
		expectEqualToOneShot(res, prepended);
	});

	test("输入收缩 → 从断点裁剪,输出共价", () => {
		const cache = createTrajectoryDeriveCache();
		const base: unknown[] = [userEntry("q1"), assistantEntry("a1"), userEntry("q2"), assistantEntry("a2")];
		deriveTrajectory(base, undefined, cache);
		const shrunk: unknown[] = base.slice(0, 2);
		const res = deriveTrajectory(shrunk, undefined, cache);
		expectEqualToOneShot(res, shrunk);
		expect(res.events.length).toBeGreaterThan(0);
	});

	test("toolResult 回填跨断点稳定:增量结果与一次性共价", () => {
		const cache = createTrajectoryDeriveCache();
		const u1 = userEntry("q1");
		const a1 = assistantEntry("a1", ["read"]);
		const callId = `call-read-${seq}`;
		const r1: unknown = {
			id: `toolResult:${callId}`,
			parentId: null,
			type: "message",
			timestamp: "2026-10-01T00:00:59.000Z",
			message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text: "file body here" }] },
		};
		const u2 = userEntry("q2");
		const step1: unknown[] = [u1, a1, r1];
		deriveTrajectory(step1, undefined, cache);

		// 追加新轮后,回填结果仍在(断点拼接没丢前缀事件的回填)。
		const step2: unknown[] = [u1, a1, r1, u2, assistantEntry("a2")];
		const res = deriveTrajectory(step2, undefined, cache);
		expectEqualToOneShot(res, step2);
		const toolEvent = res.events.find(e => e.kind === "tool");
		expect(toolEvent?.result).toContain("file body here");
	});
});

describe("deriveTrajectoryTree(分组层缓存)", () => {
	test("events 引用未变 + roundDurations 内容未变 → 分组结果引用稳定", () => {
		const cache = createTrajectoryDeriveCache();
		const base: unknown[] = [userEntry("q1"), assistantEntry("a1", ["read"]), userEntry("q2")];
		const rd = new Map([[Date.parse("2026-10-01T00:00:01.000Z"), 5000]]);
		const first = deriveTrajectoryTree(base, rd, undefined, cache);
		// 新 Map 身份、同内容(快照每帧 spread 的实际情况)。
		const again = deriveTrajectoryTree(base, new Map(rd), undefined, cache);
		expect(again).toBe(first);
	});

	test("roundDurations 内容变化 → 重新分组并生效", () => {
		const cache = createTrajectoryDeriveCache();
		const u1: unknown = {
			...(userEntry("q1") as object),
			id: "u1",
			timestamp: "2026-10-01T00:00:01.000Z",
		};
		const a1: unknown = {
			...(assistantEntry("a1") as object),
			id: "a1",
			parentId: "u1",
			timestamp: "2026-10-01T00:00:02.000Z",
		};
		const base: unknown[] = [u1, a1];
		const anchor = Date.parse("2026-10-01T00:00:01.000Z");
		const before = deriveTrajectoryTree(base, new Map([[anchor, 3000]]), undefined, cache);
		expect(before.turns[0]?.roundDurationMs).toBe(3000);
		const after = deriveTrajectoryTree(base, new Map([[anchor, 9000]]), undefined, cache);
		expect(after).not.toBe(before);
		expect(after.turns[0]?.roundDurationMs).toBe(9000);
	});
});
