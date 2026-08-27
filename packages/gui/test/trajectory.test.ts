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

	it("无工具/无消息时统计为零且事件为空", () => {
		const { events, stats } = buildTrajectory([]);
		expect(events.length).toBe(0);
		expect(stats.calls).toBe(0);
		expect(stats.turns).toBe(0);
		expect(stats.durationSec).toBe(0);
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
