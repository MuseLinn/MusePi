import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t, tLoose } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createDragClickGate,
	DRAG_CLICK_WINDOW_MS,
	TmInspector,
	TmNodeCard,
	TurnMapCanvas,
	turnEndEventOf,
	turnUserEventOf,
} from "../src/components/TurnMapCanvas";
import type { TrajectoryEvent } from "../src/components/trajectory-data";
import { TURN_NODE_H, type TurnMapNode } from "../src/components/turn-map-layout";

/**
 * 轮卡的渲染契约。
 *
 * 旧契约是「折叠 = 紧凑卡 / 展开 = 全卡 + 泳道事件卡」,而用户抱怨的正是那张
 * 展开卡:一大块重复消息文本。新契约是**索引行**——固定高度、一行省略预览、
 * 只放扫描用的事实;正文与逐事件明细在检视器里,正文本身只在对话里。
 */

function turnNode(events: TrajectoryEvent[], turn = 3, branch = false): TurnMapNode {
	const stamps = events.map(ev => ev.tsMs).filter((ms): ms is number => ms !== undefined);
	return {
		group: {
			turn,
			events,
			firstTs: new Date(stamps[0] ?? 1000).toISOString(),
			startMs: stamps[0] ?? 1000,
			endMs: stamps[stamps.length - 1] ?? 2000,
		},
		lane: branch ? 1 : 0,
		x: branch ? 264 : 0,
		y: 0,
		h: TURN_NODE_H,
		branch,
		sourceTurn: branch ? 1 : null,
		advisor: false,
		offPath: branch,
	};
}

const noop = () => {};

function renderCard(node: TurnMapNode, opts: { selected?: boolean } = {}): string {
	return renderToStaticMarkup(
		<TmNodeCard
			n={node}
			isLeaf={false}
			isCurrent={false}
			isSelected={opts.selected ?? false}
			searchDim={false}
			searchHit={false}
			onSelect={noop}
			onJump={noop}
			onSwitch={noop}
			onReanswer={noop}
			onFork={noop}
			onMenu={noop}
		/>,
	);
}

function renderInspector(node: TurnMapNode): string {
	return renderToStaticMarkup(<TmInspector node={node} onClose={noop} onJump={noop} onJumpEvent={noop} />);
}

const baseEvents: TrajectoryEvent[] = [
	{ id: "u1", kind: "user", title: "修复登录页闪烁", turn: 3, tsMs: 1000, entryId: "entry-1" },
	{ id: "a1", kind: "assistant", title: "已定位到 useEffect 依赖", turn: 3, tsMs: 1100, entryId: "entry-2" },
];

describe("轮卡是索引行,不是正文预览", () => {
	it("固定高度:卡片高度来自布局常量,与事件数无关", () => {
		const many = [...baseEvents, ...baseEvents, ...baseEvents].map((ev, i) => ({ ...ev, id: `${ev.id}-${i}` }));
		const one = renderCard(turnNode(baseEvents));
		const lots = renderCard(turnNode(many));
		expect(one).toContain(`height:${TURN_NODE_H}px`);
		expect(lots).toContain(`height:${TURN_NODE_H}px`);
	});

	it("卡内只有一行预览,没有多行正文", () => {
		const html = renderCard(turnNode(baseEvents));
		expect(html).toContain("tm-card-preview");
		// 旧实现的 tm-node-summary(两行 clamp 的正文摘要)与轮内泳道都已下线。
		expect(html).not.toContain("tm-node-summary");
		expect(html).not.toContain("tm-lane");
	});

	it("卡片带用户扫描的那几个事实:轮号、用时、回复数、工具数", () => {
		const events: TrajectoryEvent[] = [
			{ id: "u1", kind: "user", title: "问", turn: 3, tsMs: 1000 },
			{ id: "a1", kind: "assistant", title: "答", turn: 3, tsMs: 2000 },
			{ id: "t1", kind: "tool", title: "read", turn: 3, tsMs: 3000 },
		];
		const html = renderCard(turnNode(events));
		expect(html).toContain("Turn 3");
		expect(html).toContain(tLoose("transcript.turnMapReplies", { count: 1 }));
		expect(html).toContain(tLoose("transcript.turnMapTools", { count: 1 }));
		// 用时 = 首末事件差(1000 → 3000 = 2s)。
		expect(html).toContain('<span class="tm-node-dur">2s</span>');
	});

	it("离路径的轮带可见文字标记(不只靠透明度)", () => {
		const off = renderCard(turnNode(baseEvents, 3, true));
		expect(off).toContain("tm-node--off");
		expect(off).toContain("tm-card-off");
		expect(off).toContain(t("transcript.turnMapOffPath"));
		// 在路径上的轮没有这个标记。
		expect(renderCard(turnNode(baseEvents))).not.toContain("tm-card-off");
	});

	it("选中态与当前轮是两个独立的类(选中 ≠ 我在哪)", () => {
		const html = renderCard(turnNode(baseEvents), { selected: true });
		expect(html).toContain("tm-node--selected");
		expect(html).not.toContain("tm-node--current");
	});

	it("悬停操作:查看对话 + 切换 + 重答 + 分叉,全部是真按钮", () => {
		const html = renderCard(turnNode(baseEvents));
		expect(html).toContain("tm-card-actions");
		// baseEvents 带 entryId → 四个操作都可用。
		expect(html.match(/class="tm-card-act"/g)!.length).toBe(4);
		expect(html).toContain(t("transcript.turnMapViewConversation"));
		expect(html).toContain(t("transcript.mapSwitchBranch"));
		expect(html).toContain(t("transcript.branchReAnswerHere"));
		expect(html).toContain(t("transcript.forkSessionHere"));
	});

	it("无 entryId 的轮没有「查看对话」入口(无处可跳就不假装能跳)", () => {
		const events: TrajectoryEvent[] = [{ id: "s1", kind: "system", title: "model_change", turn: 3, tsMs: 1000 }];
		const html = renderCard(turnNode(events));
		expect(html).not.toContain(t("transcript.turnMapViewConversation"));
	});
});

describe("检视器是结构化的明细,不重复卡片", () => {
	it("头部:轮号 + 时间范围 + 计数 + 查看对话", () => {
		const html = renderInspector(turnNode(baseEvents));
		expect(html).toContain("tm-inspector");
		expect(html).toContain("tm-inspector-head");
		expect(html).toContain("Turn 3");
		// 时间范围(首末时刻)只在检视器出现。
		expect(html).toContain("tm-inspector-range");
		expect(html).toContain(tLoose("transcript.turnMapReplies", { count: 1 }));
		expect(html).toContain(t("transcript.turnMapViewConversation"));
	});

	it("事件行:kind 药丸 + 标签 + 耗时,逐条一行", () => {
		const events: TrajectoryEvent[] = [
			{ id: "u1", kind: "user", title: "用户问题", turn: 3, tsMs: 1000, entryId: "e1" },
			{ id: "t1", kind: "tool", title: "read", turn: 3, tsMs: 2500, entryId: "e2" },
			{ id: "a1", kind: "assistant", title: "答", turn: 3, tsMs: 4000, durationMs: 3200, entryId: "e3" },
		];
		const html = renderInspector(turnNode(events));
		expect(html.match(/tm-inspector-row /g)!.length).toBe(3);
		expect(html).toContain("tm-kind--user");
		expect(html).toContain("tm-kind--tool");
		expect(html).toContain("tm-kind--assistant");
		// assistant 行用 wire duration(3200ms → 3s);工具行没有自己的 duration,
		// 用与上一条带时刻的事件差(2500-1000 = 1.5s,durationText 取整 → 2s)。
		expect(html).toContain('<span class="tm-lane-meta">3s</span>');
		expect(html).toContain('<span class="tm-lane-meta">2s</span>');
	});

	it("检视器不含正文块(正文属于对话)", () => {
		const events: TrajectoryEvent[] = [
			{ id: "a1", kind: "assistant", title: "标题", body: "很长的正文正文正文", turn: 3, tsMs: 1000 },
		];
		const html = renderInspector(turnNode(events));
		expect(html).not.toContain("很长的正文正文正文");
		// 也没有旧的 traj-inspector-pre 正文块。
		expect(html).not.toContain("inspector-pre");
	});

	it("离路径的轮在检视器头部也标出来(选中旁支时不会误读成主线)", () => {
		const html = renderInspector(turnNode(baseEvents, 3, true));
		expect(html).toContain(t("transcript.turnMapOffPath"));
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

	it("每轮一张索引卡,缩放控件与底部横条存在", () => {
		const html = renderToStaticMarkup(<TurnMapCanvas entries={entries} />);
		expect(html.split('role="button" tabindex="0" aria-pressed').length - 1).toBe(5);
		expect(html).toContain("tm-zoom");
		expect(html).toContain("tm-nav");
		// 边是正交折线 + 箭头,不再是贝塞尔曲线。
		expect(html).toContain("tm-arrow");
		expect(html).not.toContain('<path class="tm-edge tm-edge--branch"');
	});

	it("空会话渲染空态(tm-empty)", () => {
		const html = renderToStaticMarkup(<TurnMapCanvas entries={[]} />);
		expect(html).toContain("tm-empty");
		// 词表文案在 SSR 里被 HTML 转义(撇号 → &#x27;),断言转义安全前缀。
		expect(html).toContain(t("settings.trajectoryEmpty").split("'")[0]!);
	});

	it("导航框与缩放控件避让浮动输入区", () => {
		const html = renderToStaticMarkup(<TurnMapCanvas entries={entries} composerInset={120} />);
		// 轮次条是底部横条(bottom 10 + inset),缩放控件 bottom 14 + inset。
		expect(html).toContain("bottom:130px");
		expect(html).toContain("bottom:134px");
	});

	it("右键菜单动作的可达性契约:两类导航动作不共用一个文案", () => {
		// 回归(自 SessionTreeCanvas contracts 迁移):两个不同动作共用一个
		// 标签会让屏幕阅读器播报错误的动作。地图右键 = 跳转(纯导航)与
		// 切换到此分支(移动 leaf)必须可区分。
		expect(t("settings.trajectoryJump")).not.toBe(t("transcript.mapSwitchBranch"));
		expect(t("transcript.branchReAnswerHere")).not.toBe(t("transcript.mapSwitchBranch"));
		expect(t("transcript.forkSessionHere")).not.toBe(t("transcript.mapSwitchBranch"));
		// 搜索导航(既有回归,保持覆盖)。
		expect(t("settings.trajectorySearchPrevious")).not.toBe(t("settings.trajectorySearchNext"));
		expect(t("settings.trajectorySearchPrevious")).not.toBe(t("settings.trajectoryClearFilter"));
	});
});

describe("createDragClickGate(拖拽合成 click 的抑制)", () => {
	it("平移过的拖拽只吞一次 click,拖拽结束之后的新手势不受影响", () => {
		const t = 0;
		const gate = createDragClickGate(() => t);
		gate.begin();
		gate.end(true);
		expect(gate.consume()).toBe(true);
		// 合成 click 只合成一次;之后的 click 是用户新操作。
		expect(gate.consume()).toBe(false);
		// 新手势(pointerdown)无条件作废旧抑制。
		gate.begin();
		gate.end(true);
		gate.begin();
		expect(gate.consume()).toBe(false);
	});

	it("未平移的按下不抑制(空白单击不会吞掉下一次卡片点击)", () => {
		const gate = createDragClickGate(() => 0);
		gate.begin();
		gate.end(false);
		expect(gate.consume()).toBe(false);
	});

	it("抑制在时间窗后过期:没有合成 click 时不会永久吞掉后续点击", () => {
		// 回归:抑制只由卡片处理器清零时,手势若以 pointercancel 收尾或浏览器
		// 未合成 click,标记会一直悬着,吞掉之后第一次单击与整次双击。
		let t = 0;
		const gate = createDragClickGate(() => t);
		gate.begin();
		gate.end(true);
		t += DRAG_CLICK_WINDOW_MS + 1;
		expect(gate.consume()).toBe(false);
	});
});

const mountedRoots = new Set<Root>();
afterEach(async () => {
	for (const root of mountedRoots) await act(async () => root.unmount());
	mountedRoots.clear();
	document.body.innerHTML = "";
});

function windowEntries(from: number, to: number): unknown[] {
	const result: unknown[] = [];
	for (let i = from; i <= to; i++) {
		result.push(
			{
				type: "message",
				id: `u${i}`,
				parentId: i === 1 ? null : `a${i - 1}`,
				timestamp: new Date(i * 2000).toISOString(),
				message: { role: "user", content: [{ type: "text", text: `user ${i}` }] },
			},
			{
				type: "message",
				id: `a${i}`,
				parentId: `u${i}`,
				timestamp: new Date(i * 2000 + 1000).toISOString(),
				message: { role: "assistant", content: [{ type: "text", text: `assistant ${i}` }] },
			},
		);
	}
	return result;
}

/** 分支会话(撤回形态):u1 → a1 → {旧支 u2/a2, 新支 u3/a3}。 */
function branchedEntries(): unknown[] {
	return [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date(1000).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "first question" }] },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: new Date(2000).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
		},
		// 被撤回的旧分支
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp: new Date(3000).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "withdrawn question" }] },
		},
		{
			type: "message",
			id: "a2",
			parentId: "u2",
			timestamp: new Date(4000).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "withdrawn answer" }] },
		},
		// 活跃分支
		{
			type: "message",
			id: "u3",
			parentId: "a1",
			timestamp: new Date(5000).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "second question" }] },
		},
		{
			type: "message",
			id: "a3",
			parentId: "u3",
			timestamp: new Date(6000).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "second answer" }] },
		},
	];
}

async function mount(children: React.ReactElement): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	mountedRoots.add(root);
	containerRoots.set(container, root);
	await act(async () => root.render(children));
	return container;
}

/** 在已挂载的容器上重渲染(保持 root 与视口/选中状态)。 */
async function rerender(container: HTMLElement, children: React.ReactElement): Promise<void> {
	const root = containerRoots.get(container);
	if (!root) throw new Error("rerender: container was not mounted");
	await act(async () => root.render(children));
}
const containerRoots = new Map<HTMLElement, Root>();

describe("分支会话的渲染:旁支读作旁支", () => {
	it("撤回后的旧支带 tm-node--off 与文字标记,活跃支不带", async () => {
		// pathIds = 转录在视集(活跃路径)。地图据此判离路径——这是与对话同一个
		// 答案,而不是另一套推断。
		const container = await mount(
			<TurnMapCanvas entries={branchedEntries()} pathIds={new Set(["u1", "a1", "u3", "a3"])} leafId="a3" />,
		);
		const cards = [...container.querySelectorAll<HTMLElement>(".tm-node")];
		expect(cards.length).toBe(3);
		const off = cards.filter(card => card.className.includes("tm-node--off"));
		expect(off).toHaveLength(1);
		expect(off[0]!.textContent).toContain("withdrawn question");
		expect(off[0]!.textContent).toContain(t("transcript.turnMapOffPath"));
		// 活跃支两张卡都没有 off 标记。
		const live = cards.filter(card => !card.className.includes("tm-node--off"));
		expect(live.map(card => card.textContent)).toEqual(
			expect.arrayContaining([
				expect.stringContaining("first question"),
				expect.stringContaining("second question"),
			]),
		);
	});

	it("分叉画成一次分裂:一个交汇点 + 一条「自 Turn N · …」标签", async () => {
		const container = await mount(
			<TurnMapCanvas entries={branchedEntries()} pathIds={new Set(["u1", "a1", "u3", "a3"])} leafId="a3" />,
		);
		expect(container.querySelectorAll(".tm-junction")).toHaveLength(1);
		const label = container.querySelector<HTMLElement>(".tm-split-label");
		expect(label).not.toBeNull();
		// 只有被撤回的那一轮是分支(新分支在活跃路径上,是主线),所以标签是单数。
		expect(label!.textContent).toContain(tLoose("transcript.turnMapSplitOne", { turn: "1" }));
		// 旧的车道头(每条车道重复一次「自 Turn N」)已下线。
		expect(container.querySelectorAll(".tm-lane-head")).toHaveLength(0);
	});

	it("旁支的连线一起后退(tm-edge-group--off)", async () => {
		const container = await mount(
			<TurnMapCanvas entries={branchedEntries()} pathIds={new Set(["u1", "a1", "u3", "a3"])} leafId="a3" />,
		);
		const offEdges = container.querySelectorAll(".tm-edge-group--off");
		expect(offEdges.length).toBeGreaterThanOrEqual(1);
	});

	it("未给 pathIds 时不淡显任何轮(没有路径信息就不编旁支)", async () => {
		const container = await mount(<TurnMapCanvas entries={branchedEntries()} leafId="a3" />);
		// 派生层会按 first-child 启发式标 branch,但没有对话在视集时仍按
		// offPath 标记走——这里只断言不会把三张卡全涂成旁支。
		const cards = [...container.querySelectorAll<HTMLElement>(".tm-node")];
		expect(cards.filter(card => card.className.includes("tm-node--off")).length).toBeLessThan(cards.length);
	});
});

describe("交互:单击选中、Enter/双击跳转、键盘遍历", () => {
	it("单击卡片选中并打开检视器", async () => {
		const container = await mount(<TurnMapCanvas entries={windowEntries(1, 3)} />);
		expect(container.querySelector(".tm-inspector")).toBeNull();
		const card = container.querySelector<HTMLElement>(".tm-node")!;
		await act(async () => card.click());
		expect(card.className).toContain("tm-node--selected");
		expect(container.querySelector(".tm-inspector")).not.toBeNull();
		// 检视器显示的就是这一轮。
		expect(container.querySelector(".tm-inspector")!.textContent).toContain("Turn 1");
	});

	it("双击卡片跳回对话该轮", async () => {
		const jumps: string[] = [];
		const container = await mount(
			<TurnMapCanvas entries={windowEntries(1, 3)} onJumpToEntry={id => jumps.push(id)} />,
		);
		const card = container.querySelector<HTMLElement>(".tm-node")!;
		await act(async () => card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(jumps).toEqual(["u1"]);
	});

	it("Enter 跳回对话该轮(键盘与双击同权)", async () => {
		const jumps: string[] = [];
		const container = await mount(
			<TurnMapCanvas entries={windowEntries(1, 3)} onJumpToEntry={id => jumps.push(id)} />,
		);
		const card = container.querySelector<HTMLElement>(".tm-node")!;
		await act(async () =>
			card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
		);
		expect(jumps).toEqual(["u1"]);
	});

	it("方向键在轮之间移动选中,并保持选中轮可见", async () => {
		const container = await mount(<TurnMapCanvas entries={windowEntries(1, 6)} />);
		const wrap = container.querySelector<HTMLElement>(".tm-wrap")!;
		const selectedTurn = (): string | null =>
			container.querySelector<HTMLElement>(".tm-node--selected")?.getAttribute("data-turn") ?? null;
		await act(async () =>
			wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })),
		);
		expect(selectedTurn()).toBe("1");
		await act(async () =>
			wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })),
		);
		expect(selectedTurn()).toBe("2");
		await act(async () =>
			wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })),
		);
		expect(selectedTurn()).toBe("1");
		// 选中轮一定在渲染出来的卡里(视口裁剪后仍在 DOM 中)。
		expect(container.querySelector('.tm-node--selected[data-turn="1"]')).not.toBeNull();
	});

	it("End 跳到最后一轮,Escape 收起检视器", async () => {
		const container = await mount(<TurnMapCanvas entries={windowEntries(1, 4)} />);
		const wrap = container.querySelector<HTMLElement>(".tm-wrap")!;
		await act(async () =>
			wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })),
		);
		expect(container.querySelector<HTMLElement>(".tm-node--selected")?.getAttribute("data-turn")).toBe("4");
		await act(async () =>
			wrap.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
		);
		expect(container.querySelector(".tm-inspector")).toBeNull();
	});

	it("空白处按下清掉选中(检视器随之收起)", async () => {
		const container = await mount(<TurnMapCanvas entries={windowEntries(1, 3)} />);
		await act(async () => container.querySelector<HTMLElement>(".tm-node")!.click());
		expect(container.querySelector(".tm-inspector")).not.toBeNull();
		const wrap = container.querySelector<HTMLElement>(".tm-wrap")!;
		await act(async () => {
			wrap.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 500, clientY: 500 }));
			wrap.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, clientX: 500, clientY: 500 }));
		});
		expect(container.querySelector(".tm-inspector")).toBeNull();
	});
});

describe("空白拖拽后的点击不被吞", () => {
	function pointer(type: string, target: EventTarget, x: number, y: number): void {
		act(() =>
			target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })),
		);
	}

	/** 在空白处按下、平移超过阈值、松手(浏览器随后还会在落点合成 click)。 */
	async function panBlank(container: HTMLElement): Promise<void> {
		const wrap = container.querySelector<HTMLElement>(".tm-wrap")!;
		pointer("pointerdown", wrap, 400, 400);
		pointer("pointermove", wrap, 460, 430);
		pointer("pointerup", wrap, 460, 430);
		// 关键:松手时浏览器在落点(这里是空白)合成一次 click。
		await act(async () => wrap.click());
	}

	/** 真实指针序列:pointerdown → pointerup → click(浏览器这么合成点击事件)。 */
	async function clickWithPointer(card: HTMLElement): Promise<void> {
		pointer("pointerdown", card, 400, 400);
		pointer("pointerup", card, 400, 400);
		await act(async () => card.click());
	}

	it("拖拽平移松手后,紧接着单击卡片正常选中", async () => {
		const container = await mount(<TurnMapCanvas entries={windowEntries(2, 3)} />);
		await panBlank(container);
		await clickWithPointer(container.querySelector<HTMLElement>(".tm-node")!);
		expect(container.querySelectorAll(".tm-node--selected")).toHaveLength(1);
	});

	it("拖拽被 pointercancel 中止(没有合成 click)后,下一次点卡片仍正常", async () => {
		// 手势被系统接管(触摸滚动等)时只有 pointercancel,没有 click 来
		// 消费抑制;抑制必须随下一次手势失效,不能悬着吞掉后续点击。
		const container = await mount(<TurnMapCanvas entries={windowEntries(2, 3)} />);
		const wrap = container.querySelector<HTMLElement>(".tm-wrap")!;
		pointer("pointerdown", wrap, 400, 400);
		pointer("pointermove", wrap, 460, 430);
		pointer("pointercancel", wrap, 460, 430);
		await clickWithPointer(container.querySelector<HTMLElement>(".tm-node")!);
		expect(container.querySelectorAll(".tm-node--selected")).toHaveLength(1);
	});

	it("拖拽平移松手后,紧接着双击卡片整次跳转不被吞", async () => {
		const jumps: string[] = [];
		const container = await mount(
			<TurnMapCanvas entries={windowEntries(2, 3)} onJumpToEntry={id => jumps.push(id)} />,
		);
		await panBlank(container);
		const card = container.querySelector<HTMLElement>(".tm-node")!;
		await act(async () => {
			// 双击 = 两次 (pointerdown → pointerup → click) + 一次 dblclick。
			for (let i = 0; i < 2; i++) {
				card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 400, clientY: 400 }));
				card.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 400, clientY: 400 }));
				card.click();
			}
			card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(jumps).toEqual(["u2"]);
	});
});

describe("轮次条锚定画布底缘(纵向/横向同一横条)", () => {
	const resetDirection = (): void => {
		try {
			localStorage.removeItem("musepi.map.direction");
		} catch {
			// happy-dom 一定有 localStorage;这里只是与 readMapDirection 同构。
		}
	};

	async function mountMap(composerInset = 0): Promise<HTMLElement> {
		resetDirection();
		return mount(<TurnMapCanvas entries={windowEntries(1, 3)} composerInset={composerInset} />);
	}

	it("纵向:nav 是 tm-wrap 的直接子元素,只锚底边(bottom),不占左侧/顶部", async () => {
		const container = await mountMap(120);
		const wrap = container.querySelector<HTMLElement>(".tm-wrap")!;
		const nav = container.querySelector<HTMLElement>(".tm-nav")!;
		expect(nav.parentElement).toBe(wrap);
		expect(nav.getAttribute("data-orient")).toBe("v");
		// 底部横条:bottom = 10 + composerInset;没有 top 锚点(旧左侧竖条是 top:16/bottom:16)。
		expect(nav.style.bottom).toBe("130px");
		expect(nav.style.top).toBe("");
		// 视口指示窗走横条几何(start/width),纵向视图的世界 Y 轴映射到横条 X。
		const viewport = nav.querySelector<HTMLElement>(".tm-nav-viewport");
		if (viewport) {
			expect(viewport.style.left).not.toBe("");
			expect(viewport.style.top).toBe("");
		}
	});

	it("方向切换后仍是底部横条:data-orient 变化,bottom 与锚点容器不变", async () => {
		const container = await mountMap(0);
		const nav = container.querySelector<HTMLElement>(".tm-nav")!;
		const buttons = container.querySelectorAll<HTMLButtonElement>(".tm-topbar-btn");
		await act(async () => buttons[buttons.length - 1]!.click());
		expect(nav.getAttribute("data-orient")).toBe("h");
		expect(nav.style.bottom).toBe("10px");
		expect(nav.style.top).toBe("");
		expect(nav.parentElement).toBe(container.querySelector<HTMLElement>(".tm-wrap")!);
	});
});

describe("history-window map interaction", () => {
	it("preserves the selection and zoom transform when older history arrives", async () => {
		const container = await mount(<TurnMapCanvas entries={windowEntries(2, 3)} />);
		await act(async () => container.querySelector<HTMLElement>(".tm-node")!.click());
		expect(container.querySelectorAll(".tm-node--selected")).toHaveLength(1);

		await act(async () => container.querySelectorAll<HTMLButtonElement>(".tm-zoom-btn")[1]?.click());
		const before = container.querySelector<HTMLElement>(".tm-world")?.style.transform;
		await rerender(container, <TurnMapCanvas entries={windowEntries(1, 3)} />);

		// 选中仍然落在同一轮(轮身份 = 轮起始 entry id,历史前插不改它)。
		const selected = container.querySelector<HTMLElement>(".tm-node--selected");
		expect(selected).not.toBeNull();
		expect(selected!.textContent).toContain("user 2");
		expect(container.querySelector<HTMLElement>(".tm-world")?.style.transform).toBe(before);
	});

	it("exposes turn cards as keyboard-operable buttons", () => {
		const html = renderCard(turnNode(baseEvents));
		expect(html).toContain('role="button"');
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('aria-pressed="false"');
	});
});
