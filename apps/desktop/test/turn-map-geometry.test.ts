import "./happy-dom-shim";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { setLocale } from "@musepi/client-core";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

// The map's chrome is language-dependent (turn labels, counts), so pin it.
setLocale("zh-CN");

/**
 * 会话地图的几何契约(真实 Chromium,真级联)。
 *
 * 用户抱怨的是视觉,所以事实必须在排好版的页面上量,而不是从计算样式推断:
 *
 *  1. **卡片是固定高度的索引行** —— 同一轮在事件多少两种情况下高度相同,
 *     卡内不溢出,预览是单行省略(长文本不撑宽卡片)。
 *  2. **连线表达方向** —— 路径只有 M/L/Q(没有三次贝塞尔曲线);每个直线段
 *     都正交;Q 只出现在折点做小圆角;箭头贴着子轮。
 *  3. **分叉是一处分裂** —— 兄弟分支不共享车道,任意两张卡不在两个轴上同时
 *     重叠;交汇点只画一个。
 *  4. **没有嵌套滚动条**(M80 溢出契约)—— 画布本体不滚;检视器只有纵向
 *     一条,横向显式 clip。
 *
 * 说明:这里量的是 SSR 标记 + 真实 CSS 级联(页面不跑 React 副作用,所以
 * `fitView` 不会执行,视图保持初始 transform)。几何契约(卡高、路径、溢出
 * 声明、不透明度)全部在级联里成立;点击/键盘交互由 happy-dom 的
 * `turn-map-canvas.test.tsx` 覆盖,那里才有真实的事件处理器。
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CASCADE = ["gui-base.css", "gui-workspace.css", "gui-chat.css"]
	.map(file => fs.readFileSync(path.join(STYLES, file), "utf8"))
	.join("\n");

const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { TurnMapCanvas, TmInspector } = require("../src/components/TurnMapCanvas");

/** 方向是持久化偏好(`musepi.map.direction`)。几何断言要么显式钉住方向,
 *  要么对方向不敏感——这里两者都做:先清掉偏好回到纵向默认。 */
function vertical(html: string): string {
	try {
		globalThis.localStorage?.removeItem("musepi.map.direction");
	} catch {
		// 没有 localStorage 时 readMapDirection 本身就回退纵向。
	}
	return html;
}

/** 分支会话:u1 → a1 → {撤回的 u2/a2, 活跃的 u3/a3}。 */
function branchedEntries(): unknown[] {
	const msg = (id: string, parentId: string | null, role: string, text: string, ts: number) => ({
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message: { role, content: [{ type: "text", text }] },
	});
	return [
		msg("u1", null, "user", "first question", 1000),
		msg("a1", "u1", "assistant", "first answer", 2000),
		msg("u2", "a1", "user", "withdrawn question", 3000),
		msg("a2", "u2", "assistant", "withdrawn answer", 4000),
		msg("u3", "a1", "user", "second question", 5000),
		msg("a3", "u3", "assistant", "second answer", 6000),
	];
}

/** 线性会话:N 轮,每轮 eventsPerTurn 条消息。 */
function linearEntries(turns: number, eventsPerTurn = 2): unknown[] {
	const out: unknown[] = [];
	let parent: string | null = null;
	for (let i = 1; i <= turns; i++) {
		for (let j = 0; j < eventsPerTurn; j++) {
			const id = j === 0 ? `u${i}` : `x${j}-${i}`;
			out.push({
				type: "message",
				id,
				parentId: parent,
				timestamp: new Date(i * 10000 + j * 100).toISOString(),
				message: { role: j === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}-${j}` }] },
			});
			parent = id;
		}
	}
	return out;
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1100, height: 800 });
});

afterAll(async () => {
	await browser.close();
}, 60_000);

/** 在真实级联里挂载标记并量几何。`seatHeight` 约束检视器所在的 seat。 */
async function measure(html: string, opts: { seatHeight?: number } = {}) {
	await page.setContent(`
		<style>
			:root {
				--color-bg: rgb(24, 24, 26);
				--color-surface: rgb(32, 32, 34);
				--color-text: rgb(235, 235, 235);
				--color-text-muted: rgb(160, 160, 160);
				--color-text-faint: rgb(120, 120, 120);
				--color-accent: rgb(90, 150, 240);
				--color-warning: rgb(230, 180, 90);
				--border: rgb(70, 70, 70);
				--radius-xs: 3px;
				--radius-sm: 4px;
				--radius-md: 8px;
				--radius-lg: 12px;
				--radius-xl: 14px;
				--radius-full: 999px;
				--spring: cubic-bezier(0.22, 0.8, 0.3, 1);
				--gui-glass-bg: color-mix(in oklab, rgb(24, 24, 26) 80%, transparent);
				--gui-glass-border: color-mix(in oklab, rgb(235, 235, 235) 12%, transparent);
				--font-mono: ui-monospace, monospace;
			}
			${CASCADE}
			body { margin: 0; }
			#stage { position: relative; width: 1040px; height: 720px; }
			#seat { position: absolute; right: 14px; top: 96px; width: 320px; ${
				opts.seatHeight === undefined ? "" : `height: ${opts.seatHeight}px;`
			} }
		</style>
		<div id="stage">${html}</div>`);
	// 两帧足够:入场动画不参与任何被测几何,而 tm-breathe 是无限动画
	// (`animation.finished` 永不 resolve,会挂满超时并让 frame 脱离)。
	await page.evaluate(
		() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
	return page.evaluate(() => {
		const box = (el: Element | null) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			const round = (n: number) => Math.round(n * 100) / 100;
			return {
				top: round(r.top),
				left: round(r.left),
				width: round(r.width),
				height: round(r.height),
				bottom: round(r.bottom),
				right: round(r.right),
			};
		};
		const one = (s: string) => document.querySelector<HTMLElement>(s);
		const all = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
		const scrollInfo = (el: HTMLElement | null) => {
			if (!el) return null;
			const cs = getComputedStyle(el);
			return {
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				scrollWidth: el.scrollWidth,
				clientWidth: el.clientWidth,
				overflowX: cs.overflowX,
				overflowY: cs.overflowY,
			};
		};
		return {
			wrap: box(one(".tm-wrap")),
			wrapScroll: scrollInfo(one(".tm-wrap")),
			cards: all(".tm-node").map(el => ({
				box: box(el),
				off: el.classList.contains("tm-node--off"),
				text: el.textContent ?? "",
				scrollHeight: el.scrollHeight,
				clientHeight: el.clientHeight,
				opacity: Number(getComputedStyle(el).opacity),
			})),
			paths: all("path.tm-edge").map(el => ({
				branch: el.classList.contains("tm-edge--branch"),
				d: el.getAttribute("d") ?? "",
			})),
			arrowGroups: all(".tm-edge-group").map(group => ({
				off: group.classList.contains("tm-edge-group--off"),
				opacity: Number(getComputedStyle(group).opacity),
				// 箭头三角形的尖端 = 第一个顶点。
				tip: (() => {
					const poly = group.querySelector("polygon.tm-arrow");
					if (!poly) return null;
					const [x, y] = poly.getAttribute("points")!.split(" ")[0]!.split(",").map(Number);
					return { x, y };
				})(),
			})),
			junctions: all("circle.tm-junction").length,
			splitLabels: all(".tm-split-label").map(el => el.textContent ?? ""),
			preview: all(".tm-card-preview").map(el => ({
				whiteSpace: getComputedStyle(el).whiteSpace,
				textOverflow: getComputedStyle(el).textOverflow,
				scrollWidth: el.scrollWidth,
				clientWidth: el.clientWidth,
			})),
			inspectorRows: scrollInfo(one(".tm-inspector-rows")),
			inspector: box(one(".tm-inspector")),
			// 画布内所有声明了滚动轴的容器。
			scrollers: all("#stage *")
				.map(el => {
					const cs = getComputedStyle(el);
					const scrollsY = /(auto|scroll|overlay)/.test(cs.overflowY);
					const scrollsX = /(auto|scroll|overlay)/.test(cs.overflowX);
					return scrollsX || scrollsY
						? {
								cls: el.className?.toString?.() ?? "",
								scrollsX,
								scrollsY,
								scrollWidth: el.scrollWidth,
								clientWidth: el.clientWidth,
							}
						: null;
				})
				.filter(Boolean),
		};
	});
}

/** 路径 d 的段列表:只有 M / L / Q(没有 C = 没有任意曲线)。 */
function pathSegments(d: string): { cmd: string; values: number[] }[] {
	const out: { cmd: string; values: number[] }[] = [];
	for (const match of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
		out.push({
			cmd: match[1]!,
			values: match[2]!
				.trim()
				.split(/[\s,]+/)
				.filter(Boolean)
				.map(Number),
		});
	}
	return out;
}

describe("卡片是固定高度的索引行(真实级联)", () => {
	test("同一轮在事件多少两种情况下卡高相同,且卡内不溢出", async () => {
		const few = await measure(
			vertical(renderToStaticMarkup(React.createElement(TurnMapCanvas, { entries: linearEntries(3, 2) }))),
		);
		const many = await measure(
			vertical(renderToStaticMarkup(React.createElement(TurnMapCanvas, { entries: linearEntries(3, 12) }))),
		);
		expect(few.cards.length).toBe(3);
		expect(many.cards.length).toBe(3);
		// 卡高一致(取整:视口缩放在子像素上留小数)。
		const heights = (m: typeof few) => new Set(m.cards.map(c => Math.round(c.box!.height)));
		expect(heights(few).size).toBe(1);
		expect([...heights(many)]).toEqual([...heights(few)]);
		// 卡内没有内容溢出(固定高度真的装得下三行)。
		for (const card of [...few.cards, ...many.cards]) {
			expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight + 1);
		}
	});

	test("预览是单行省略:nowrap + ellipsis,长文本不撑宽卡片", async () => {
		const long = "这是一段很长很长的用户提问文本,它不应该把卡片撑宽,也不应该换行成多行正文。".repeat(3);
		const entries = [
			{
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: new Date(1000).toISOString(),
				message: { role: "user", content: [{ type: "text", text: long }] },
			},
		];
		const m = await measure(vertical(renderToStaticMarkup(React.createElement(TurnMapCanvas, { entries }))));
		const preview = m.preview[0]!;
		expect(preview.whiteSpace).toBe("nowrap");
		expect(preview.textOverflow).toBe("ellipsis");
		// 内容比可视区宽(所以省略号真的会出现),但卡片宽度仍是布局常量。
		// 读 inline 宽度而不是 getBoundingClientRect:后者带视口缩放的小数
		// (fitView 在 mount 后按容器算比例,单卡时略小于 1)。
		expect(preview.scrollWidth).toBeGreaterThan(preview.clientWidth);
		const cardWidth = await page.evaluate(() => document.querySelector<HTMLElement>(".tm-node")!.style.width);
		expect(cardWidth).toBe("208px");
	});
});

describe("连线表达方向(真实级联)", () => {
	test("主线边只有 M/L/Q,每个直线段都正交,箭头贴在子轮顶缘", async () => {
		const m = await measure(
			vertical(renderToStaticMarkup(React.createElement(TurnMapCanvas, { entries: linearEntries(4, 2) }))),
		);
		const mains = m.paths.filter(p => !p.branch);
		expect(mains.length).toBe(3);
		for (const edge of mains) {
			// 没有三次贝塞尔曲线 —— 用户抱怨的「任意曲线」就是从这来的。
			expect(edge.d).not.toContain("C");
			const segs = pathSegments(edge.d);
			expect(segs[0]!.cmd).toBe("M");
			for (let i = 1; i < segs.length; i++) {
				const prev = segs[i - 1]!;
				const cur = segs[i]!;
				const from = prev.cmd === "M" ? prev.values : prev.values.slice(-2);
				const to = cur.cmd === "L" ? cur.values : cur.values.slice(-2);
				if (cur.cmd === "L") {
					// 直线段:同一 x(垂直)或同一 y(水平)。
					expect(from[0] === to[0] || from[1] === to[1]).toBe(true);
				}
			}
			// 主线是一条同轴直线:起点与终点共享 x(纵向)或 y(横向)。
			const first = segs[0]!.values;
			const last = segs[segs.length - 1]!.values.slice(-2);
			expect(first[0] === last[0] || first[1] === last[1]).toBe(true);
		}
		// 每条主线边一个箭头,且尖端朝下(指向子轮)。
		expect(m.arrowGroups.length).toBe(mains.length);
		for (const group of m.arrowGroups) {
			expect(group.tip).not.toBeNull();
		}
	});

	test("分支边:先走干线残端再横出,折点只用小圆角 Q", async () => {
		const m = await measure(
			renderToStaticMarkup(
				React.createElement(TurnMapCanvas, {
					entries: branchedEntries(),
					pathIds: new Set(["u1", "a1", "u3", "a3"]),
					leafId: "a3",
				}),
			),
		);
		const branches = m.paths.filter(p => p.branch);
		expect(branches.length).toBeGreaterThanOrEqual(1);
		for (const edge of branches) {
			expect(edge.d).not.toContain("C");
			const segs = pathSegments(edge.d);
			// 至少一个 L 段是水平的(横出到车道)——分裂要看得见。
			const lSegs = segs.filter(s => s.cmd === "L");
			expect(lSegs.length).toBeGreaterThanOrEqual(2);
			// Q 只在折点出现,且半径很小(小圆角,不是弧线连接)。
			for (const q of segs.filter(s => s.cmd === "Q")) {
				const [cx, cy, ex, ey] = q.values as [number, number, number, number];
				const radius = Math.hypot(ex - cx, ey - cy);
				expect(radius).toBeLessThanOrEqual(6);
			}
		}
	});

	test("分叉:交汇点只画一个,任意两张卡不在两个轴上同时重叠", async () => {
		const m = await measure(
			renderToStaticMarkup(
				React.createElement(TurnMapCanvas, {
					entries: branchedEntries(),
					pathIds: new Set(["u1", "a1", "u3", "a3"]),
					leafId: "a3",
				}),
			),
		);
		expect(m.junctions).toBe(1);
		expect(m.splitLabels.length).toBe(1);
		// 同列的主线卡上下排是合法的;缺陷是两张卡真的压在一起。
		const boxes = m.cards.map(c => c.box!);
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i]!;
				const b = boxes[j]!;
				const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
				const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
				expect(overlapX > 0 && overlapY > 0).toBe(false);
			}
		}
	});
});

describe("离路径的轮在页面上真的后退(真实级联)", () => {
	test("旁支卡与旁支边的实际不透明度低于主线", async () => {
		const m = await measure(
			renderToStaticMarkup(
				React.createElement(TurnMapCanvas, {
					entries: branchedEntries(),
					pathIds: new Set(["u1", "a1", "u3", "a3"]),
					leafId: "a3",
				}),
			),
		);
		const offCard = m.cards.find(c => c.off);
		const liveCard = m.cards.find(c => !c.off);
		expect(offCard).toBeDefined();
		expect(liveCard).toBeDefined();
		expect(offCard!.opacity).toBeLessThan(liveCard!.opacity);
		// 旁支仍在(不是隐藏)。
		expect(m.cards.filter(c => c.off).length).toBe(1);
		expect(offCard!.text).toContain("withdrawn question");

		const offEdge = m.arrowGroups.find(g => g.off);
		const liveEdge = m.arrowGroups.find(g => !g.off);
		expect(offEdge).toBeDefined();
		expect(liveEdge).toBeDefined();
		expect(offEdge!.opacity).toBeLessThan(liveEdge!.opacity);
	});
});

describe("没有嵌套滚动条(M80 溢出契约)", () => {
	test("画布本体不滚:tm-wrap 两个轴都是 hidden", async () => {
		const m = await measure(
			vertical(renderToStaticMarkup(React.createElement(TurnMapCanvas, { entries: linearEntries(30, 2) }))),
		);
		const wrap = m.wrapScroll!;
		expect(wrap.overflowX).toBe("hidden");
		expect(wrap.overflowY).toBe("hidden");
	});

	test("检视器只有纵向滚动,横向显式 clip(不会出现横向滚动条)", async () => {
		// 直接挂检视器本体:它是被量几何的那个面,点击→挂载的交互由 happy-dom 覆盖。
		const group = {
			turn: 4,
			events: Array.from({ length: 24 }, (_, i) => ({
				id: `e${i}`,
				kind: i === 0 ? ("user" as const) : ("tool" as const),
				title: `read some/rather/long/path/segment-${i}.ts`,
				turn: 4,
				tsMs: 1000 + i * 100,
				entryId: `entry-${i}`,
			})),
			startMs: 1000,
			endMs: 3400,
		};
		const node = {
			group,
			lane: 0,
			x: 0,
			y: 0,
			h: 66,
			branch: false,
			sourceTurn: null,
			advisor: false,
			offPath: false,
		};
		const m = await measure(
			`<div id="seat"><div class="tm-inspector-seat" style="position:relative;inset:auto;height:100%"><div class="tm-inspector" style="max-height:100%">${renderToStaticMarkup(
				React.createElement(TmInspector, { node, onClose: () => {}, onJump: () => {}, onJumpEvent: () => {} }),
			)
				.replace(/^<div class="tm-inspector"[^>]*>/, "")
				.replace(/<\/div>$/, "")}</div></div></div>`,
			{ seatHeight: 240 },
		);
		const rows = m.inspectorRows!;
		expect(rows).not.toBeNull();
		expect(rows.overflowY).toBe("auto");
		expect(rows.overflowX).toBe("clip");
		// 真的溢出了(所以纵向滚动有意义),且没有横向溢出。
		expect(rows.scrollHeight).toBeGreaterThan(rows.clientHeight);
		expect(rows.scrollWidth).toBeLessThanOrEqual(rows.clientWidth + 1);
	});

	test("画布内没有任何「内容完整却横向可滚」的容器", async () => {
		const m = await measure(
			renderToStaticMarkup(
				React.createElement(TurnMapCanvas, {
					entries: branchedEntries(),
					pathIds: new Set(["u1", "a1", "u3", "a3"]),
				}),
			),
		);
		for (const s of m.scrollers as Array<{
			scrollsX: boolean;
			scrollWidth: number;
			clientWidth: number;
			cls: string;
		}>) {
			if (!s.scrollsX) continue;
			expect(s.scrollWidth).toBeLessThanOrEqual(s.clientWidth + 1);
		}
	});
});
