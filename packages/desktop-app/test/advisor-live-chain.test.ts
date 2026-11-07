/**
 * 实机回归(会话 01a1a5a1,顾问卡插在两段助手回复之间):
 *
 * daemon 的 `stampLiveMessageParentId` 把新消息挂在「最近的 MESSAGE 祖先」上,
 * 于是顾问卡与应用它的回复成为同父兄弟。后果成对出现:
 *  1. 转录:活跃路径从尾条目向上走不经过卡片 → 卡片被当 off-path 隐藏,
 *     回复一到顾问消息就「消失」;
 *  2. 地图:卡片被读成上一条回复的「重答」分支,而轮数标签只数主线轮 →
 *     画布画 N 张卡、标题写 N-1 轮。
 *
 * 契约:SDK 投影还原诚实链(卡 → 回复),日志序相邻 + 同父 + display 可见
 * 三条同时成立才重挂(见 MaterializedView#attachToSplicedCard)。本测试把
 * 「SDK 投影 → 活跃路径 → 轨迹 → 地图」整条链路串起来,防止两侧再次漂移。
 */
import { describe, expect, test } from "bun:test";
import { MaterializedView } from "@musepi/sdk";
import { buildTrajectoryTree } from "../src/components/trajectory-data";
import { layoutTurnMap } from "../src/components/turn-map-layout";
import { filterVisibleEntries, walkLeafPath } from "../src/lib/leaf-walk";

type Entry = { id: string; parentId: string | null };

function userEvent(ts: number, parentId: string | null, text: string) {
	return {
		type: "message_end" as const,
		message: { role: "user", content: [{ type: "text", text }], timestamp: ts, parentId },
	};
}

function assistantEvent(ts: number, parentId: string | null, text: string) {
	return {
		type: "message_end" as const,
		message: { role: "assistant", content: [{ type: "text", text }], timestamp: ts, parentId },
	};
}

function advisorEvent(ts: number, parentId: string | null) {
	return {
		type: "message_end" as const,
		message: {
			role: "custom",
			customType: "advisor",
			content: '<advisory severity="nit">round 2 was never live</advisory>',
			display: true,
			parentId,
			details: { notes: [{ note: "round 2 was never live", severity: "nit" }] },
			timestamp: ts,
		},
	};
}

/** 会话形状(简化为两问 + 一条顾问笔记):顾问卡挂在最后一条助手回复
 *  (assistant:7000)上,而它之后那条回复按 daemon 的 live 打标仍指向
 *  assistant:7000 —— 正是「被拼接」的父链。 */
const SESSION = [
	userEvent(1000, null, "跟我打个招呼吧"),
	assistantEvent(2000, "user:1000", "你好呀"),
	userEvent(3000, "assistant:2000", "拉一个子 agent 对几轮"),
	assistantEvent(4000, "user:3000", "alice 已就位"),
	assistantEvent(5000, "assistant:4000", "第 1 轮完成"),
	assistantEvent(6000, "assistant:5000", "alice 跑完 2 轮"),
	assistantEvent(7000, "assistant:6000", "跑完了,照实汇报"),
	advisorEvent(8000, "assistant:7000"),
	assistantEvent(9000, "assistant:7000", "你提醒得对,我纠正一下"),
];

type Node = { id: string; parentId: string | null };

function projectLive(): readonly unknown[] {
	const view = MaterializedView.replay("s1", "/tmp", []);
	for (const ev of SESSION) view.apply(ev as never);
	return view.snapshot().entries;
}

/** 修复前的形状:新回复直接挂在最近的消息祖先上,顾问卡成为兄弟。 */
function projectSpliced(): readonly unknown[] {
	return SESSION.map(ev => {
		const m = ev.message;
		const timestamp = new Date(m.timestamp).toISOString();
		if (m.role === "custom") {
			return {
				type: "custom_message",
				id: `custom:${m.timestamp}`,
				parentId: m.parentId,
				timestamp,
				customType: m.customType,
				content: m.content,
				display: m.display,
				details: m.details,
			};
		}
		return { type: "message", id: `${m.role}:${m.timestamp}`, parentId: m.parentId, timestamp, message: m };
	});
}

function lastId(entries: readonly unknown[]): string {
	return (entries[entries.length - 1] as Node).id;
}

function idsOf(entries: readonly unknown[]): string[] {
	return entries.map(e => (e as Node).id);
}

describe("顾问卡 live 父链修复(会话 01a1a5a1)", () => {
	test("the reply hangs off the advisor card instead of jumping over it", () => {
		const entries = projectLive();
		expect(idsOf(entries)).toEqual([
			"user:1000",
			"assistant:2000",
			"user:3000",
			"assistant:4000",
			"assistant:5000",
			"assistant:6000",
			"assistant:7000",
			"custom:8000",
			"assistant:9000",
		]);
		expect(entries[7]).toMatchObject({ id: "custom:8000", parentId: "assistant:7000" });
		expect(entries[8]).toMatchObject({ id: "assistant:9000", parentId: "custom:8000" });
	});

	test("the card stays on the active path, so the transcript keeps it after the reply", () => {
		const entries = projectLive();
		const walk = walkLeafPath(entries, lastId(entries));
		expect(walk.complete).toBe(true);
		expect(walk.path.map(n => n.id)).toContain("custom:8000");

		const activePath = new Set(walk.path.map(n => n.id));
		const visible = filterVisibleEntries(entries, walk, activePath, { pinnedToRoot: false });
		expect(idsOf(visible)).toContain("custom:8000");
	});

	test("the advisor note is a main-line turn, not a re-answer branch", () => {
		const entries = projectLive();
		const walk = walkLeafPath(entries, lastId(entries));
		const activePath = new Set(walk.path.map(n => n.id));
		const { turns, stats } = buildTrajectoryTree(entries, undefined, activePath);

		const advisor = turns.flatMap(t => t.events).find(e => e.kind === "advisor");
		expect(advisor?.branch).toBeUndefined();
		// 两问 + 一条顾问笔记 = 3 轮:顾问笔记按设计开启一轮(isTurnStartEntry)。
		expect(stats.turns).toBe(3);
	});

	test("map nodes and the round count agree (no phantom re-answer lane)", () => {
		const entries = projectLive();
		const walk = walkLeafPath(entries, lastId(entries));
		const activePath = new Set(walk.path.map(n => n.id));
		const { turns, stats } = buildTrajectoryTree(entries, undefined, activePath);
		const layout = layoutTurnMap(turns);

		expect(layout.nodes.every(n => !n.branch)).toBe(true);
		expect(layout.main).toHaveLength(stats.turns);
		expect(layout.lanes).toHaveLength(0);
	});

	test("control: the unrepaired splice reproduces the drop and the fake branch", () => {
		const entries = projectSpliced();
		const walk = walkLeafPath(entries, lastId(entries));
		expect(walk.path.map(n => n.id)).not.toContain("custom:8000");
		expect(
			idsOf(filterVisibleEntries(entries, walk, new Set(walk.path.map(n => n.id)), { pinnedToRoot: false })),
		).not.toContain("custom:8000");

		const { turns, stats } = buildTrajectoryTree(entries, undefined, new Set(walk.path.map(n => n.id)));
		expect(turns.flatMap(t => t.events).find(e => e.kind === "advisor")?.branch).toBe(true);
		// 卡片被判成分支 → 轮数少一轮,而地图照样为它画节点:标题与画布不一致。
		expect(stats.turns).toBe(2);
		expect(layoutTurnMap(turns).nodes).toHaveLength(3);
	});
});
