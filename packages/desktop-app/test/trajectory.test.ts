import { describe, expect, it } from "bun:test";
import { buildTrajectory, buildTrajectoryTree, isTrajectoryEventInRange } from "../src/components/trajectory-data";

// 会话轨迹视图(DSH Trajectory 参考吸收):entries → 事件时间线 + 统计。

function userEntry(ts: string, text: string): unknown {
	return { type: "message", timestamp: ts, message: { role: "user", content: [{ type: "text", text }] } };
}

function assistantEntry(
	ts: string,
	opts: {
		text?: string;
		toolName?: string;
		args?: unknown;
		toolId?: string;
		usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		duration?: number;
		ttft?: number;
	},
): unknown {
	const content: unknown[] = [];
	if (opts.text) content.push({ type: "text", text: opts.text });
	if (opts.toolName) {
		content.push({
			type: "toolCall",
			id: opts.toolId ?? `call-${opts.toolName}`,
			name: opts.toolName,
			arguments: opts.args ?? {},
		});
	}
	const message: Record<string, unknown> = { role: "assistant", content };
	if (opts.usage) {
		message.usage = {
			input: opts.usage.input ?? 0,
			output: opts.usage.output ?? 0,
			cacheRead: opts.usage.cacheRead ?? 0,
			cacheWrite: opts.usage.cacheWrite ?? 0,
			totalTokens: (opts.usage.input ?? 0) + (opts.usage.output ?? 0),
		};
	}
	if (opts.duration !== undefined) message.duration = opts.duration;
	if (opts.ttft !== undefined) message.ttft = opts.ttft;
	return { type: "message", timestamp: ts, message };
}

function toolResultEntry(ts: string, toolCallId: string, text: string): unknown {
	return {
		type: "message",
		timestamp: ts,
		message: { role: "toolResult", toolCallId, content: [{ type: "text", text }] },
	};
}

describe("buildTrajectory", () => {
	it("分支消息打 branch 标记;线性消息不带", () => {
		// 线性:user Q1 → assistant A1 → user Q2;分支:user Q2 的 parentId
		// 指向 Q1(重答场景)而非前驱 A1 → Q2 及其回复标记 branch。
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-08-17T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "第一问" }] },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-08-17T00:00:01.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "第一答" }] },
			},
			{
				type: "message",
				id: "u2",
				parentId: "a1",
				timestamp: "2026-08-17T00:00:02.000Z",
				message: { role: "user", content: [{ type: "text", text: "第二问" }] },
			},
			{
				type: "message",
				id: "a2",
				parentId: "u2",
				timestamp: "2026-08-17T00:00:03.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "第二答" }] },
			},
			// 分支点:重答 Q2 → 新分支 Q3(parentId 指向 u2,而非前驱 a2)。
			{
				type: "message",
				id: "u3",
				parentId: "u2",
				timestamp: "2026-08-17T00:00:04.000Z",
				message: { role: "user", content: [{ type: "text", text: "重答分支" }] },
			},
			{
				type: "message",
				id: "a3",
				parentId: "u3",
				timestamp: "2026-08-17T00:00:05.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "分支回复" }] },
			},
		];
		const { events } = buildTrajectory(entries);
		expect(events.filter(e => e.branch).map(e => e.title)).toEqual(["重答分支", "分支回复"]);
		expect(events.filter(e => !e.branch).map(e => e.title)).toEqual(["第一问", "第一答", "第二问", "第二答"]);
	});

	it("提取工具调用为 TOOL 事件并回填结果", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "调用 runtime_tool"),
			assistantEntry("2026-08-17T00:00:01.000Z", {
				toolName: "runtime_tool",
				args: { message: "hi" },
				toolId: "call-1",
			}),
			toolResultEntry("2026-08-17T00:00:02.000Z", "call-1", "runtime tool works"),
		];
		const { events, stats } = buildTrajectory(entries);
		expect(stats.calls).toBe(1);
		expect(stats.turns).toBe(1);
		expect(stats.durationSec).toBe(2);
		const tool = events.find(e => e.kind === "tool");
		expect(tool?.title).toBe("runtime_tool");
		expect(tool?.body).toContain("hi");
		expect(tool?.result).toBe("runtime tool works");
		expect(tool?.turn).toBe(1);
	});

	it("user 消息分 turn,assistant 文本/thinking 各成事件", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:01.000Z", { text: "回答一" }),
			userEntry("2026-08-17T00:00:02.000Z", "第二问"),
			assistantEntry("2026-08-17T00:00:03.000Z", { text: "回答二" }),
		];
		const { events, stats } = buildTrajectory(entries);
		expect(stats.turns).toBe(2);
		expect(stats.calls).toBe(0);
		expect(events.filter(e => e.kind === "user").length).toBe(2);
		expect(events.filter(e => e.kind === "assistant").length).toBe(2);
	});

	it("顾问(advisor)笔记各开一轮:display:true 计入轮数,display:false 不计", () => {
		// 与折叠/导航层同一 isTurnStart 口径(customType:"advisor" && display:true)。
		const advisorEntry = (ts: string, text: string, display: boolean): unknown => ({
			type: "custom_message",
			customType: "advisor",
			display,
			timestamp: ts,
			content: [{ type: "text", text }],
		});
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:01.000Z", { text: "回答一" }),
			// display:false 的顾问笔记不开轮(与折叠/导航一致)。
			advisorEntry("2026-08-17T00:00:02.000Z", "静默提醒", false),
			advisorEntry("2026-08-17T00:00:03.000Z", "这里有并发风险", true),
			assistantEntry("2026-08-17T00:00:04.000Z", { text: "修复了并发问题" }),
			userEntry("2026-08-17T00:00:05.000Z", "第二问"),
		];
		const { events, stats } = buildTrajectory(entries);
		// user ×2 + advisor(display) ×1 = 3 轮(旧口径 assistant 消息数 = 2,差数即顾问轮)。
		expect(stats.turns).toBe(3);
		const advisor = events.filter(e => e.kind === "advisor");
		expect(advisor).toHaveLength(1);
		expect(advisor[0]!.title).toBe("这里有并发风险");
		expect(advisor[0]!.turn).toBe(2);
		// 顾问轮后续的 assistant 事件归入该轮。
		expect(events.find(e => e.title === "修复了并发问题")?.turn).toBe(2);
	});

	it("无工具/无消息时统计为零且事件为空", () => {
		const { events, stats } = buildTrajectory([]);
		expect(events.length).toBe(0);
		expect(stats.calls).toBe(0);
		expect(stats.turns).toBe(0);
		expect(stats.durationSec).toBe(0);
	});
});

describe("buildTrajectory 活跃叶路径(activePath)", () => {
	// 用户场景:4 轮问答后撤回到第 2 轮发新消息 —— 新轮应是"第 3 轮"
	// (新分支深度),旧 3/4 轮是废弃分支;不提供 activePath 时保持旧
	// first-child 行为(新轮 = journal 追加序第 5 轮,即回归保护的 bug 形态)。
	function branchedSession(): unknown[] {
		const msg = (id: string, parentId: string | null, ts: string, role: string, text: string): unknown => ({
			type: "message",
			id,
			parentId,
			timestamp: ts,
			message: { role, content: [{ type: "text", text }] },
		});
		return [
			msg("u1", null, "2026-09-26T00:00:00.000Z", "user", "第一问"),
			msg("a1", "u1", "2026-09-26T00:00:01.000Z", "assistant", "回答一"),
			msg("u2", "a1", "2026-09-26T00:00:02.000Z", "user", "第二问"),
			msg("a2", "u2", "2026-09-26T00:00:03.000Z", "assistant", "回答二"),
			// 旧分支:原第 3、4 轮(branchAt 后废弃)。
			msg("u3", "a2", "2026-09-26T00:00:04.000Z", "user", "旧第三问"),
			msg("a3", "u3", "2026-09-26T00:00:05.000Z", "assistant", "旧回答三"),
			msg("u4", "a3", "2026-09-26T00:00:06.000Z", "user", "旧第四问"),
			msg("a4", "u4", "2026-09-26T00:00:07.000Z", "assistant", "旧回答四"),
			// 新主线:撤回第 2 轮后发送(branchAt → parentId = a2,追加在尾部)。
			msg("u3n", "a2", "2026-09-26T00:00:08.000Z", "user", "新第三问"),
			msg("a3n", "u3n", "2026-09-26T00:00:09.000Z", "assistant", "新回答三"),
		];
	}
	const activePath = new Set(["u1", "a1", "u2", "a2", "u3n", "a3n"]);

	it("主线/分支按活跃路径判定:旧链整体 branch,新主线轮不带 branch", () => {
		const { events } = buildTrajectory(branchedSession(), activePath);
		const branchTitles = events.filter(e => e.branch === true).map(e => e.title);
		expect(branchTitles).toEqual(["旧第三问", "旧回答三", "旧第四问", "旧回答四"]);
		const mainTitles = events.filter(e => e.branch !== true).map(e => e.title);
		expect(mainTitles).toEqual(["第一问", "回答一", "第二问", "回答二", "新第三问", "新回答三"]);
	});

	it("pathTurn = 树深度:新主线轮重新编号为第 3 轮(不是追加序第 5 轮)", () => {
		const { events } = buildTrajectory(branchedSession(), activePath);
		expect(events.find(e => e.title === "新第三问")?.turn).toBe(5); // journal 组键仍唯一
		expect(events.find(e => e.title === "新第三问")?.pathTurn).toBe(3);
		expect(events.find(e => e.title === "旧第三问")?.pathTurn).toBe(3); // 废弃分支同深度
		expect(events.find(e => e.title === "旧第四问")?.pathTurn).toBe(4);
		expect(events.find(e => e.title === "第二问")?.pathTurn).toBe(2);
	});

	it("stats.turns 只数主线轮(废弃分支不占当前会话轮数)", () => {
		const { stats } = buildTrajectory(branchedSession(), activePath);
		expect(stats.turns).toBe(3);
		// 无 activePath:旧 first-child 行为(journal 全量计数)。
		const legacy = buildTrajectory(branchedSession());
		expect(legacy.stats.turns).toBe(5);
	});

	it("buildTrajectoryTree:组展示编号 displayTurn = 新分支深度", () => {
		const { turns } = buildTrajectoryTree(branchedSession(), undefined, activePath);
		// 组键(journal 序)唯一:1,2,3(旧),4(旧),5(新)。
		expect(turns.map(g => g.turn)).toEqual([1, 2, 3, 4, 5]);
		// 展示编号:新主线轮 = 3;旧分支轮保留各自深度编号。
		expect(turns.map(g => g.displayTurn)).toEqual([1, 2, 3, 4, 3]);
		// 主线判定喂给布局:旧 3/4 轮组首事件带 branch,新轮不带。
		expect(turns[2]!.events[0]!.branch).toBe(true);
		expect(turns[4]!.events[0]!.branch).not.toBe(true);
	});

	it("空 activePath(撤回过根)回退旧 first-child 行为,不误标全分支", () => {
		// first-child 链跟随先追加的旧分支 → 旧 3/4 轮算主线,新轮被标 branch。
		const { events } = buildTrajectory(branchedSession(), new Set());
		expect(events.filter(e => e.branch === true).map(e => e.title)).toEqual(["新第三问", "新回答三"]);
	});
});

describe("buildTrajectoryTree", () => {
	it("按 turn 分组且组内保持事件顺序", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:01.000Z", { text: "回答一", toolName: "runtime_tool", toolId: "call-1" }),
			toolResultEntry("2026-08-17T00:00:02.000Z", "call-1", "ok"),
			userEntry("2026-08-17T00:00:03.000Z", "第二问"),
			assistantEntry("2026-08-17T00:00:04.000Z", { text: "回答二" }),
		];
		const { turns, stats } = buildTrajectoryTree(entries);
		expect(turns).toHaveLength(2);
		expect(stats.turns).toBe(2);
		expect(stats.calls).toBe(1);
		// Turn 1: user → assistant(tool call) → toolResult backfill;组内顺序 = 事件序。
		expect(turns[0]!.turn).toBe(1);
		expect(turns[0]!.firstTs).toBe("2026-08-17T00:00:00.000Z");
		expect(turns[0]!.events.map(e => e.kind)).toEqual(["user", "tool", "assistant"]);
		expect(turns[0]!.events[1]?.result).toBe("ok");
		// Turn 2: user + assistant。
		expect(turns[1]!.turn).toBe(2);
		expect(turns[1]!.firstTs).toBe("2026-08-17T00:00:03.000Z");
		expect(turns[1]!.events.map(e => e.kind)).toEqual(["user", "assistant"]);
	});

	it("无事件时返回空 turns", () => {
		const { turns, stats } = buildTrajectoryTree([]);
		expect(turns).toHaveLength(0);
		expect(stats.calls).toBe(0);
		expect(stats.turns).toBe(0);
	});
});

describe("轨迹时序字段(Overview 时间轴数据源)", () => {
	it("事件带数值时间戳 tsMs,树按 turn 展开 startMs/endMs", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:05.000Z", { text: "回答一" }),
			userEntry("2026-08-17T00:00:10.000Z", "第二问"),
			assistantEntry("2026-08-17T00:00:12.000Z", { text: "回答二" }),
		];
		const { turns } = buildTrajectoryTree(entries);
		const t1 = turns[0]!;
		const t2 = turns[1]!;
		expect(t1.startMs).toBe(Date.parse("2026-08-17T00:00:00.000Z"));
		expect(t1.endMs).toBe(Date.parse("2026-08-17T00:00:05.000Z"));
		expect(t2.startMs).toBe(Date.parse("2026-08-17T00:00:10.000Z"));
		expect(t2.endMs).toBe(Date.parse("2026-08-17T00:00:12.000Z"));
		// 无 roundDurations 时不虚构回合时长。
		expect(t1.roundDurationMs).toBeUndefined();
		// 事件自身的 tsMs 用于区间判定。
		expect(turns.flatMap(g => g.events).every(e => e.tsMs !== undefined)).toBe(true);
	});

	it("roundDurations(Map 形态)命中 assistant 锚后闭合回合:endMs = start + duration", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:02.000Z", { text: "回答一" }),
			userEntry("2026-08-17T00:00:20.000Z", "第二问"),
			assistantEntry("2026-08-17T00:00:22.000Z", { text: "回答二" }),
		];
		const anchor1 = Date.parse("2026-08-17T00:00:02.000Z");
		const anchor2 = Date.parse("2026-08-17T00:00:22.000Z");
		const roundDurations = new Map<number, number>([
			[anchor1, 8_000], // 回合1:2s 处开始工作,10s 处结束
			[anchor2, 5_000],
		]);
		const { turns } = buildTrajectoryTree(entries, roundDurations);
		const t1 = turns[0]!;
		const t2 = turns[1]!;
		expect(t1.roundDurationMs).toBe(8_000);
		expect(t1.endMs).toBe(t1.startMs! + t1.roundDurationMs!);
		expect(t2.roundDurationMs).toBe(5_000);
		expect(t2.endMs).toBe(t2.startMs! + t2.roundDurationMs!);
		// 未命中(如该轮还在跑)的 turn 不闭合。
		const { turns: live } = buildTrajectoryTree(entries, new Map([[anchor1, 8_000]]));
		expect(live[1]!.roundDurationMs).toBeUndefined();
	});

	it("roundDurations 接受持久化 [ms, ms][] 形态", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:02.000Z", { text: "回答一" }),
		];
		const anchor = Date.parse("2026-08-17T00:00:02.000Z");
		const { turns } = buildTrajectoryTree(entries, [[anchor, 7_000]] as const);
		expect(turns[0]!.roundDurationMs).toBe(7_000);
	});

	it("isTrajectoryEventInRange:区间闭合判定,无 tsMs 的事件永不命中", () => {
		expect(isTrajectoryEventInRange({ tsMs: 1_000 } as never, 0, 2_000)).toBe(true);
		expect(isTrajectoryEventInRange({ tsMs: 1_000 } as never, 1_000, 1_000)).toBe(true);
		expect(isTrajectoryEventInRange({ tsMs: 1_000 } as never, 2_000, 3_000)).toBe(false);
		expect(isTrajectoryEventInRange({} as never, 0, 3_000)).toBe(false);
	});

	it("settled assistant 消息提取 usage/duration/ttft(检视器数据,与 transcript usage 行同源)", () => {
		const entries = [
			userEntry("2026-08-17T00:00:00.000Z", "第一问"),
			assistantEntry("2026-08-17T00:00:02.000Z", {
				text: "回答一",
				usage: { input: 1_234, output: 567, cacheRead: 890, cacheWrite: 45 },
				duration: 8_500,
				ttft: 320,
			}),
			assistantEntry("2026-08-17T00:00:05.000Z", { text: "回答二" }),
		];
		const { turns } = buildTrajectoryTree(entries);
		const settled = turns[0]!.events.find(e => e.kind === "assistant")!;
		expect(settled.usage).toEqual({
			input: 1_234,
			output: 567,
			cacheRead: 890,
			cacheWrite: 45,
			totalTokens: 1_801,
		});
		expect(settled.durationMs).toBe(8_500);
		expect(settled.ttftMs).toBe(320);
		// 未 settled 的 assistant 事件不带统计(undefined,不虚构)。
		const unsettled = turns[0]!.events.filter(e => e.kind === "assistant")[1]!;
		expect(unsettled.usage).toBeUndefined();
		expect(unsettled.durationMs).toBeUndefined();
		expect(unsettled.ttftMs).toBeUndefined();
	});
});
