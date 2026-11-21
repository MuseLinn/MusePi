import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import { t, tLoose } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createDragClickGate,
	DRAG_CLICK_WINDOW_MS,
	TmNodeCard,
	TurnMapCanvas,
	turnEndEventOf,
	turnUserEventOf,
} from "../src/components/TurnMapCanvas";
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

function renderCard(node: TurnMapNode, isExpanded: boolean): string {
	return renderToStaticMarkup(
		<TmNodeCard
			n={node}
			isLeaf={false}
			isCurrent={false}
			isExpanded={isExpanded}
			searchDim={false}
			searchHit={false}
			onToggle={noop}
			onJump={noop}
			onJumpEvent={noop}
			onSwitchEvent={noop}
			onReanswerEvent={noop}
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
		expect(html).toContain(tLoose("transcript.turnMapCompactCount", { count: 2 }));
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
		// ttft 走词表(硬编码英文会在 zh-CN 下漏翻)。
		expect(html).toContain(t("transcript.turnMapTtft", { duration: "0.2s" }));
	});

	it("泳道明细:工具行双行卡(参数摘要副行,tab 净化)", () => {
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
		expect(html).toContain("tm-lane-detail");
		// 主行摘要 = 工具名(副行给参数)。
		expect(html).toContain("tm-lane-title");
		expect(html).toContain("read");
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
		// 契约:entryId → 可点击行(单击/双击跳对话);无 entryId → 纯展示。
		expect(html).toContain("tm-lane-row--link");
		expect(html.match(/tm-lane-row--link/g)!.length).toBe(1);
	});

	it("泳道事件卡:kind 药丸按事件类型渲染,悬停操作按 kind 分派", () => {
		const events: TrajectoryEvent[] = [
			{ id: "u1", kind: "user", title: "用户问题", turn: 3, tsMs: 1000, entryId: "entry-1" },
			{ id: "a1", kind: "assistant", title: "回答", turn: 3, tsMs: 1001, entryId: "entry-2" },
			{ id: "t1", kind: "tool", title: "read", turn: 3, tsMs: 1002, entryId: "entry-3" },
		];
		const html = renderCard(turnNode(events), true);
		// 契约:每张事件卡带 kind 药丸(用户能一眼区分 user/assistant/工具)。
		expect(html.match(/tm-kind--user/g)!.length).toBe(1);
		expect(html.match(/tm-kind--assistant/g)!.length).toBe(1);
		expect(html.match(/tm-kind--tool/g)!.length).toBe(1);
		// 契约:悬停操作分派——user 行 = 切换 + 重答(2 个),非 user 行 =
		// 仅切换(1 个);与分支树行的 branchAt 语义分派一致。
		expect(html.match(/class="tm-lane-act"/g)!.length).toBe(4);
		expect(html.match(/git-branch/g)!.length).toBe(1);
		expect(html.match(/git-merge/g)!.length).toBe(3);
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

	async function mount(entries: unknown[]): Promise<HTMLElement> {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mountedRoots.add(root);
		await act(async () => root.render(<TurnMapCanvas entries={entries} />));
		return container;
	}

	/** 真实指针序列:pointerdown → pointerup → click(浏览器这么合成点击事件)。 */
	async function clickWithPointer(card: HTMLElement): Promise<void> {
		pointer("pointerdown", card, 400, 400);
		pointer("pointerup", card, 400, 400);
		await act(async () => card.click());
	}

	it("拖拽平移松手后,紧接着单击卡片正常折叠/展开", async () => {
		const container = await mount(windowEntries(2, 3));
		await panBlank(container);
		await clickWithPointer(container.querySelector<HTMLElement>(".tm-node")!);
		await act(async () => Bun.sleep(260));
		expect(container.querySelectorAll(".tm-node:not(.tm-node--compact)")).toHaveLength(1);
	});

	it("拖拽被 pointercancel 中止(没有合成 click)后,下一次点卡片仍正常", async () => {
		// 手势被系统接管(触摸滚动等)时只有 pointercancel,没有 click 来
		// 消费抑制;抑制必须随下一次手势失效,不能悬着吞掉后续点击。
		const container = await mount(windowEntries(2, 3));
		const wrap = container.querySelector<HTMLElement>(".tm-wrap")!;
		pointer("pointerdown", wrap, 400, 400);
		pointer("pointermove", wrap, 460, 430);
		pointer("pointercancel", wrap, 460, 430);
		await clickWithPointer(container.querySelector<HTMLElement>(".tm-node")!);
		await act(async () => Bun.sleep(260));
		expect(container.querySelectorAll(".tm-node:not(.tm-node--compact)")).toHaveLength(1);
	});

	it("拖拽平移松手后,紧接着双击卡片整次跳转不被吞", async () => {
		const jumps: string[] = [];
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mountedRoots.add(root);
		await act(async () =>
			root.render(<TurnMapCanvas entries={windowEntries(2, 3)} onJumpToEntry={id => jumps.push(id)} />),
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
		await act(async () => Bun.sleep(260));
		expect(jumps).toEqual(["u2"]);
		// 双击不残留折叠(第一次 click 被消歧窗口吞掉)。
		expect(container.querySelectorAll(".tm-node:not(.tm-node--compact)")).toHaveLength(0);
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
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mountedRoots.add(root);
		await act(async () => root.render(<TurnMapCanvas entries={windowEntries(1, 3)} composerInset={composerInset} />));
		return container;
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
	it("preserves the expanded turn and zoom transform when older history arrives", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		mountedRoots.add(root);
		await act(async () => root.render(<TurnMapCanvas entries={windowEntries(2, 3)} />));
		await act(async () => container.querySelector<HTMLElement>(".tm-node")?.click());
		await act(async () => Bun.sleep(260));
		expect(container.querySelectorAll(".tm-node:not(.tm-node--compact)")).toHaveLength(1);

		await act(async () => container.querySelectorAll<HTMLButtonElement>(".tm-zoom-btn")[1]?.click());
		const before = container.querySelector<HTMLElement>(".tm-world")?.style.transform;
		await act(async () => root.render(<TurnMapCanvas entries={windowEntries(1, 3)} />));

		const cards = [...container.querySelectorAll<HTMLElement>(".tm-node")];
		expect(cards[0]?.className).toContain("tm-node--compact");
		expect(cards[1]?.className).not.toContain("tm-node--compact");
		expect(cards[1]?.textContent).toContain("user 2");
		expect(container.querySelector<HTMLElement>(".tm-world")?.style.transform).toBe(before);
	});

	it("exposes turn cards as keyboard-operable buttons", () => {
		const html = renderCard(turnNode(baseEvents), false);
		expect(html).toContain('role="button"');
		expect(html).toContain('tabindex="0"');
		expect(html).toContain('aria-expanded="false"');
	});
});
