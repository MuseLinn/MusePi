import "./dom-shim";
import { describe, expect, it } from "bun:test";
import { t, tLoose } from "@musepi/client-core";
import { renderToStaticMarkup } from "react-dom/server";
import { TmNodeCard, TurnMapCanvas, turnEndEventOf, turnUserEventOf } from "../src/components/TurnMapCanvas";
import type { TrajectoryEvent } from "../src/components/trajectory-data";
import type { TurnMapNode } from "../src/components/turn-map-layout";

/**
 * 轮卡两态渲染契约(折叠 = 单行紧凑卡;展开 = 全卡 + 泳道明细)。
 * renderToStaticMarkup 断言可观察 DOM——折叠状态机的两个渲染分支各自
 * 的可见结果,以及泳道明细(trace 对齐)的存在性。
 */

function turnNode(events: TrajectoryEvent[], turn = 3, branch = false): TurnMapNode {
	return {
		group: { turn, events, firstTs: new Date(1000).toISOString(), startMs: 1000, endMs: 2000 },
		lane: branch ? 1 : 0,
		x: branch ? 264 : 0,
		y: 0,
		h: 40,
		branch,
		sourceTurn: branch ? 1 : null,
		advisor: false,
		expandedExtra: 0,
	};
}

const noop = () => {};

function renderCard(node: TurnMapNode, isExpanded: boolean, selectedEventId: string | null = null): string {
	return renderToStaticMarkup(
		<TmNodeCard
			n={node}
			isLeaf={false}
			isCurrent={false}
			isExpanded={isExpanded}
			searchDim={false}
			searchHit={false}
			selectedEventId={selectedEventId}
			onToggle={noop}
			onJump={noop}
			onSelectEvent={noop}
			onJumpEvent={noop}
			onEventMenu={noop}
			onMenu={noop}
			onHover={noop}
		/>,
	);
}

const baseEvents: TrajectoryEvent[] = [
	{ id: "u1", kind: "user", title: "修复登录页闪烁", turn: 3, tsMs: 1000 },
	{ id: "a1", kind: "assistant", title: "已定位到 useEffect 依赖", turn: 3, tsMs: 1100 },
];

describe("轮卡折叠/展开渲染分支", () => {
	it("折叠态:单行紧凑卡(徽章 + 摘要 + 事件计数 + 用时),无泳道", () => {
		const html = renderCard(turnNode(baseEvents), false);
		expect(html).toContain("tm-node--compact");
		expect(html).toContain("tm-compact-summary");
		expect(html).toContain("Turn 3");
		expect(html).toContain("修复登录页闪烁");
		// 计数走 i18n 词表(事件数 = 2)。
		expect(html).toContain(tLoose("turn map compact count", { count: 2 }));
		// 泳道与构成条只在展开态出现。
		expect(html).not.toContain("tm-lane");
		expect(html).not.toContain("tm-comp-seg");
	});

	it("展开态:全卡 + 泳道事件行", () => {
		const html = renderCard(turnNode(baseEvents), true);
		expect(html).not.toContain("tm-node--compact");
		expect(html).toContain("tm-lane");
		expect(html).toContain("tm-lane-row--user");
		expect(html).toContain("tm-lane-row--assistant");
		expect(html).toContain("已定位到 useEffect 依赖");
	});

	it("泳道明细:assistant 行带 usage/duration/ttft", () => {
		const events: TrajectoryEvent[] = [
			{
				id: "a2",
				kind: "assistant",
				title: "回复",
				body: "回复正文",
				turn: 3,
				tsMs: 1100,
				usage: { input: 12300, output: 456, cacheRead: 0, cacheWrite: 0 },
				durationMs: 3200,
				ttftMs: 210,
			},
		];
		const html = renderCard(turnNode(events), true);
		// ↑/↓ usage(≥10k 缩写为 k)、请求耗时与首字节延迟。
		expect(html).toContain("tm-lane-usage");
		expect(html).toContain("↑12.3k");
		expect(html).toContain("↓456");
		// durationText 粗粒度:3200ms → "3s"、210ms → "0.2s"(ttft 前缀标识)。
		expect(html).toContain('<span class="tm-lane-meta">3s</span>');
		expect(html).toContain("ttft 0.2s");
	});

	it("泳道明细:工具行带参数摘要(单行,tab 净化)", () => {
		const events: TrajectoryEvent[] = [
			{
				id: "t1",
				kind: "tool",
				title: "read",
				body: '{"file_path":"src/a.ts","limit":\t200}',
				turn: 3,
				tsMs: 1050,
			},
		];
		const html = renderCard(turnNode(events), true);
		expect(html).toContain("tm-lane-args");
		// tab 已净化为空格(裸 tab 会破坏终端/文本渲染)。
		expect(html).not.toContain("\t");
		// 参数摘要渲染出 JSON 键(引号在 SSR 中转义为 &quot;)。
		expect(html).toContain("&quot;file_path&quot;");
	});

	it("泳道事件行:带 entryId 的可点击定位(link 类),无 entryId 不可点", () => {
		const events: TrajectoryEvent[] = [
			{ id: "u1", kind: "user", title: "用户问题", turn: 3, tsMs: 1000, entryId: "entry-1" },
			{ id: "s1", kind: "system", title: "model_change", turn: 3, tsMs: 1001 },
		];
		const html = renderCard(turnNode(events), true);
		// 契约:entryId → 可点击行(单击选中 + 双击跳对话);无 entryId → 纯展示。
		expect(html).toContain("tm-lane-row--link");
		expect(html.match(/tm-lane-row--link/g)!.length).toBe(1);
	});

	it("泳道事件卡:kind 图标按事件类型渲染,选中态跟随 selectedEventId", () => {
		const events: TrajectoryEvent[] = [
			{ id: "u1", kind: "user", title: "用户问题", turn: 3, tsMs: 1000, entryId: "entry-1" },
			{ id: "a1", kind: "assistant", title: "回答", turn: 3, tsMs: 1001, entryId: "entry-2" },
		];
		const html = renderCard(turnNode(events), true, "a1");
		// 契约:每张事件卡带 kind 图标(用户能一眼区分 user/assistant/工具)。
		expect(html.match(/tm-lane-icon/g)!.length).toBe(2);
		// 契约:selectedEventId 命中的卡带选中描边类,其余没有。
		expect(html).toContain("tm-lane-row--selected");
		expect(html.match(/tm-lane-row--selected/g)!.length).toBe(1);
	});
});

describe("树操作锚选择(切换/重答的分叉语义)", () => {
	// 实机回归(2026-10-02,会话 01a0f81b):地图「切换到此分支」以轮首
	// user 事件为锚 → branchAt 的 user→parent 重答语义生效——leaf 落到
	// 该轮之前、草稿回填该轮文本,用户看到"怎么切换都停在旧分支 + 输入框
	// 出现草稿」。切换必须锚到轮末(assistant/工具),重答才锚轮首 user。
	const group = {
		turn: 2,
		events: [
			{ id: "u1", kind: "user" as const, title: "再说一遍", turn: 2, entryId: "entry-u" },
			{ id: "a1", kind: "assistant" as const, title: "回答", turn: 2, entryId: "entry-a" },
			{ id: "s1", kind: "system" as const, title: "model_change", turn: 2 },
		],
		firstTs: new Date(1000).toISOString(),
		startMs: 1000,
		endMs: 2000,
	};

	it("切换锚 = 轮末带 entryId 的事件,不是轮首 user(锚回 user = 重答语义)", () => {
		expect(turnEndEventOf(group)?.id).toBe("a1");
		expect(turnEndEventOf(group)?.kind).not.toBe("user");
	});

	it("重答锚 = 轮首 user 事件(无 user 事件的轮回退轮末)", () => {
		expect(turnUserEventOf(group)?.id).toBe("u1");
		const noUser = { ...group, events: group.events.filter(e => e.kind !== "user") };
		expect(turnUserEventOf(noUser)?.id).toBe("a1");
	});
});

describe("TurnMapCanvas SSR 冒烟", () => {
	const entries: unknown[] = [];
	for (let i = 1; i <= 5; i++) {
		entries.push({
			type: "message",
			id: `u${i}`,
			parentId: i === 1 ? null : `a${i - 1}`,
			timestamp: new Date(i * 100).toISOString(),
			message: { role: "user", content: [{ type: "text", text: `user ${i}` }] },
		});
		entries.push({
			type: "message",
			id: `a${i}`,
			parentId: `u${i}`,
			timestamp: new Date(i * 100 + 50).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: `assistant ${i}` }] },
		});
	}

	it("默认全折叠:每轮一张紧凑卡,缩放控件存在", () => {
		const html = renderToStaticMarkup(<TurnMapCanvas entries={entries} />);
		expect(html.split("tm-node--compact").length - 1).toBe(5);
		expect(html).toContain("tm-zoom");
		expect(html).toContain("tm-nav");
	});

	it("空会话渲染空态(tm-empty)", () => {
		const html = renderToStaticMarkup(<TurnMapCanvas entries={[]} />);
		expect(html).toContain("tm-empty");
		// 词表文案在 SSR 里被 HTML 转义(撇号 → &#x27;),断言转义安全前缀。
		expect(html).toContain(t("trajectory empty").split("'")[0]!);
	});

	it("右键菜单动作的可达性契约:两类导航动作不共用一个文案", () => {
		// 回归(自 SessionTreeCanvas contracts 迁移):两个不同动作共用一个
		// 标签会让屏幕阅读器播报错误的动作。地图右键 = 跳转(纯导航)与
		// 切换到此分支(移动 leaf)必须可区分。
		expect(t("trajectory jump")).not.toBe(t("map switch to branch"));
		expect(t("branch re-answer here")).not.toBe(t("map switch to branch"));
		expect(t("fork session here")).not.toBe(t("map switch to branch"));
		// 搜索导航(既有回归,保持覆盖)。
		expect(t("trajectory search previous")).not.toBe(t("trajectory search next"));
		expect(t("trajectory search previous")).not.toBe(t("trajectory clear filter"));
	});
});
