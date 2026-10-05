import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FloatingScrollbar } from "../src/components/FloatingScrollbar";
import { readAlwaysShowScrollbar, saveAlwaysShowScrollbar } from "../src/lib/scrollbar-skins";

/**
 * FloatingScrollbar 的外部可观察契约。
 *
 * 这些断言覆盖的是消费者能看见的行为：哪条轨出现、它有多长、它停在哪里、
 * 一次滚动里做了多少布局读、哪些退出条件会收回轨。组件内部如何组织这些
 * 步骤（measure/position 拆分、池的槽位分配）不在断言范围内 —— 但"稳态滚动
 * 零布局读、只写 transform"是性能契约，必须按可测的方式钉住：用可控的
 * getter 统计布局读次数，并断言只写入了 transform。
 */

class TestResizeObserver implements ResizeObserver {
	static instances: TestResizeObserver[] = [];
	readonly callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void;
	disconnectCount = 0;
	private readonly targets = new Set<Element>();

	constructor(callback: (entries: ResizeObserverEntry[], observer: ResizeObserver) => void) {
		this.callback = callback;
		TestResizeObserver.instances.push(this);
	}
	disconnect(): void {
		this.disconnectCount += 1;
		this.targets.clear();
	}
	observe(el: Element): void {
		this.targets.add(el);
	}
	unobserve(el: Element): void {
		this.targets.delete(el);
	}
	observed(): Element[] {
		return Array.from(this.targets);
	}
	trigger(): void {
		this.callback([], this as unknown as ResizeObserver);
	}
}

let host: HTMLDivElement;
let scroller: HTMLDivElement;
let root: Root;
let pendingFrames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let scrollTop: number;
let scrollLeft: number;
let clientHeight: number;
let scrollHeight: number;
let clientWidth: number;
let scrollWidth: number;
let rect: { top: number; left: number; width: number; height: number; right: number };
let verticalLayoutReads: number;
let horizontalLayoutReads: number;
let originalGlobals: {
	ResizeObserver: typeof globalThis.ResizeObserver;
	requestAnimationFrame: typeof globalThis.requestAnimationFrame;
	cancelAnimationFrame: typeof globalThis.cancelAnimationFrame;
};

const flushFrames = async (): Promise<void> => {
	await act(async () => {
		const frames = Array.from(pendingFrames.values());
		pendingFrames.clear();
		for (const cb of frames) cb(0);
	});
};

const rail = (): HTMLElement => {
	const el = host.querySelector<HTMLElement>(".gui-float-scrollbar[data-visible]");
	if (!el) throw new Error("no visible rail");
	return el;
};

const verticalThumb = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(".gfs-v, .gfs-pac")!;
const horizontalThumb = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(".gfs-h")!;

/** Bind a scrollable element into the DOM with controllable geometry. */
function mountScroller(
	opts: { className?: string; parent?: HTMLElement; overflowY?: string; overflowX?: string } = {},
): HTMLDivElement {
	const el = document.createElement("div");
	if (opts.className) el.className = opts.className;
	// The overlay trusts a range only on an axis the user can actually scroll,
	// so the fixture has to declare itself a scroll container — `auto` on both
	// axes is what every real pane uses. A bare div computes to `visible`.
	el.style.overflowY = opts.overflowY ?? "auto";
	el.style.overflowX = opts.overflowX ?? "auto";
	document.body.appendChild(el);
	(opts.parent ?? host).appendChild(el);
	Object.defineProperties(el, {
		clientHeight: { configurable: true, get: () => clientHeight },
		scrollHeight: { configurable: true, get: () => scrollHeight },
		clientWidth: { configurable: true, get: () => clientWidth },
		scrollWidth: { configurable: true, get: () => scrollWidth },
		scrollTop: {
			configurable: true,
			get: () => scrollTop,
			set: (v: number) => {
				scrollTop = v;
			},
		},
		scrollLeft: {
			configurable: true,
			get: () => scrollLeft,
			set: (v: number) => {
				scrollLeft = v;
			},
		},
		// A METHOD, not an accessor: it stands in for the real call and counts
		// the layout read it forces.
		getBoundingClientRect: {
			configurable: true,
			value: (): DOMRect => {
				verticalLayoutReads += 1;
				horizontalLayoutReads += 1;
				const r = { ...rect, x: rect.left, y: rect.top, bottom: rect.top + rect.height };
				return { ...r, toJSON: () => r } as DOMRect;
			},
		},
	});
	return el;
}

/** Wait past one liveness-probe tick (the overlay probes every 600ms). */
const waitForProbe = async (): Promise<void> => {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 700));
	});
	await flushFrames();
};

const userScroll = (el: HTMLElement): void => {
	el.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true }));
	el.dispatchEvent(new window.Event("scroll", { bubbles: false }));
};

const programmaticScroll = (el: HTMLElement): void => {
	el.dispatchEvent(new window.Event("scroll", { bubbles: false }));
};

beforeEach(async () => {
	localStorage.clear();
	host = document.createElement("div");
	document.body.appendChild(host);
	pendingFrames = new Map();
	nextFrameId = 1;
	TestResizeObserver.instances = [];
	scrollTop = 0;
	scrollLeft = 0;
	clientHeight = 100;
	scrollHeight = 500;
	clientWidth = 100;
	scrollWidth = 100;
	rect = { top: 0, left: 0, width: 100, height: 100, right: 100 };
	verticalLayoutReads = 0;
	horizontalLayoutReads = 0;

	// Capture the real globals so they are restored in afterEach — bun runs
	// every test file in one process, and a leaked fake ResizeObserver or rAF
	// would silently break whichever file runs next.
	originalGlobals = {
		ResizeObserver: globalThis.ResizeObserver,
		requestAnimationFrame: globalThis.requestAnimationFrame,
		cancelAnimationFrame: globalThis.cancelAnimationFrame,
	};
	Object.assign(globalThis, {
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: TestResizeObserver,
		requestAnimationFrame: (cb: FrameRequestCallback): number => {
			const id = nextFrameId++;
			pendingFrames.set(id, cb);
			return id;
		},
		cancelAnimationFrame: (id: number): void => {
			pendingFrames.delete(id);
		},
	});

	root = createRoot(host);
	await act(async () => {
		root.render(createElement(FloatingScrollbar));
	});
	await flushFrames();
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	host.remove();
	localStorage.clear();
	// Restore the globals this file replaced so the rest of the suite sees the
	// real implementations.
	Object.assign(globalThis, originalGlobals);
});

describe("FloatingScrollbar 挂载与轨道池", () => {
	test("初始无任何轨出现，池槽位常驻但不可见", () => {
		expect(host.querySelectorAll(".gui-float-scrollbar").length).toBeGreaterThan(1);
		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).toBeNull();
	});

	test("两个容器可同时持有各自的轨，而不是只有最后滚动的那一个", async () => {
		const a = mountScroller();
		const b = mountScroller();
		rect = { top: 0, left: 0, width: 100, height: 100, right: 100 };

		userScroll(a);
		await flushFrames();
		userScroll(b);
		await flushFrames();

		const visible = Array.from(host.querySelectorAll<HTMLElement>(".gui-float-scrollbar[data-visible]"));
		expect(visible.length).toBe(2);
		// 两条轨都贴在各自容器的右缘（同尺寸容器 → 同一 left），
		// 高度覆盖各自的可视区，且落在不同的槽位上。
		expect(new Set(visible.map(el => el.style.left)).size).toBe(1);
		expect(new Set(visible.map(el => el.style.height)).size).toBe(1);
		expect(new Set(visible.map(el => el.dataset.slot)).size).toBe(2);
	});

	test("容器内容收回到不溢出时必定收回该轨（提前 return 收敛到统一 retract）", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		expect(host.querySelectorAll(".gui-float-scrollbar[data-visible]").length).toBe(1);

		// 内容折叠回可视高度。探活确认容器不再溢出后收回该轨 —— 此前这条
		// 路径上没有任何检查，残轨会永久挂在静态内容上。
		scrollHeight = clientHeight;
		await waitForProbe();

		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).toBeNull();
	});

	test("容器脱离文档后轨被回收（不需要新滚动来唤醒它）", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).not.toBeNull();

		// 容器卸载后不再有任何事件，只有探活周期能收它 —— 这正是此前残轨
		// 会永久悬在无关 UI 上的原因（用户：进入设置后仍在）。
		el.remove();
		await waitForProbe();

		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).toBeNull();
	});

	test("容器尺寸归零时轨被回收", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();

		rect = { top: 0, left: 0, width: 100, height: 0, right: 100 };
		await waitForProbe();

		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).toBeNull();
	});

	test("超过池容量时回收最冷槽位，观察器不跨容器累积", async () => {
		// Track every observed element per observer so the assertion is about
		// the pool's bookkeeping, not about counting calls.
		const seen = new Map<TestResizeObserver, Set<Element>>();
		const first = mountScroller();
		userScroll(first);
		await flushFrames();
		for (const o of TestResizeObserver.instances) seen.set(o, new Set(o.observed()));
		expect(host.querySelectorAll(".gui-float-scrollbar[data-visible]").length).toBe(1);

		// More containers than the pool holds, so eviction must happen.
		for (let i = 0; i < 8; i += 1) {
			userScroll(mountScroller());
			await flushFrames();
		}

		expect(host.querySelectorAll(".gui-float-scrollbar[data-visible]").length).toBeLessThanOrEqual(6);
		// Each slot watches at most its own container plus that container's
		// direct children — never a stale container from an earlier binding.
		for (const observer of TestResizeObserver.instances) {
			expect(observer.observed().length).toBeLessThanOrEqual(2);
		}
		// The coldest container's slot was handed on, so it is no longer shown.
		const shownSlots = new Set(
			Array.from(host.querySelectorAll<HTMLElement>(".gui-float-scrollbar[data-visible]")).map(
				el => el.dataset.slot,
			),
		);
		expect(shownSlots.size).toBe(host.querySelectorAll(".gui-float-scrollbar[data-visible]").length);
	});
});

describe("FloatingScrollbar 热路径", () => {
	test("稳态滚动零布局读、零布局属性写，只写 transform", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		const shown = rail();
		const v = verticalThumb(shown);
		const rootLeft = shown.style.left;
		const rootTop = shown.style.top;
		const rootHeight = shown.style.height;
		const thumbHeight = v.style.height;

		// Count every layout read and every inline-style write from here on.
		// Baseline: the periodic liveness probe also reads rects, and it is not
		// part of the scrolling path. Quiesce first, then measure only the burst.
		await waitForProbe();
		verticalLayoutReads = 0;
		horizontalLayoutReads = 0;
		const writes: string[] = [];
		for (const el2 of [shown, v, horizontalThumb(shown)]) {
			const original = el2.style.setProperty.bind(el2.style);
			el2.style.setProperty = (name: string, value: string, priority?: string): void => {
				writes.push(name);
				original(name, value, priority);
			};
			// happy-dom assigns `style.top = x` through setProperty too.
			const desc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "top");
			if (desc?.set) {
				Object.defineProperty(el2.style, "top", {
					configurable: true,
					get: () => shown.style.getPropertyValue("top"),
					set: (value: string) => {
						writes.push("top");
						original("top", value);
					},
				});
			}
		}

		// A real wheel burst: many scroll events, coalesced into one frame.
		scrollTop = 200;
		for (let i = 0; i < 20; i += 1) {
			el.dispatchEvent(new window.WheelEvent("wheel", { bubbles: true }));
			el.dispatchEvent(new window.Event("scroll"));
		}

		// Count only the coalesced pass: the scroll handlers above must already
		// have queued work without measuring, and the idle/probe timers read
		// rects on their own schedule (documented liveness cost, not the hot path).
		verticalLayoutReads = 0;
		horizontalLayoutReads = 0;
		await flushFrames();

		expect(verticalLayoutReads).toBe(0);
		expect(horizontalLayoutReads).toBe(0);
		// The pass wrote transforms and nothing that touches layout. `transition`
		// is the one other property a scroll pass may write: cancelling an armed
		// release spring (see the spring regression case below).
		expect(writes.length).toBeGreaterThan(0);
		for (const property of new Set(writes)) {
			expect(["transform", "transition"]).toContain(property);
		}
		expect(writes).not.toContain("height");
		expect(writes).not.toContain("top");
		// The thumb moved along the track; the rail's own box did not. The gummy
		// base also carries its squash-and-stretch scaleY in the same transform.
		expect(v.style.transform).toMatch(/^translate3d\(0(px)?, \d+(?:\.\d+)?px, 0(px)?\)( scaleY\(1\.06\))?$/);
		expect(Number.parseFloat(v.style.transform.match(/,\s*(\d+(?:\.\d+)?)px/)![1])).toBeGreaterThan(0);
		expect(shown.style.left).toBe(rootLeft);
		expect(shown.style.top).toBe(rootTop);
		expect(shown.style.height).toBe(rootHeight);
		expect(v.style.height).toBe(thumbHeight);
	});

	test("拇指位移与滚动距离成正比，且不套着回弹动画（用户：非线性 + 卡顿 + 往上拖不动）", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		const shown = rail();
		const v = verticalThumb(shown);

		// 让 140ms 的 settle 真的跑完，装上回弹 spring。
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 200));
		});
		await flushFrames();
		expect(v.style.transition).not.toBe("");

		// 之后的每一次滚动都必须在写新 transform 之前先拆掉 spring ——
		// 420ms 的 back-out 曲线会把每一帧动画化，拇指就追不上滚动距离。
		for (const offset of [100, 200, 300]) {
			scrollTop = offset;
			el.dispatchEvent(new window.Event("scroll"));
			await flushFrames();
			expect(v.style.transition).toBe("none");
		}

		// 位移严格线性：等距滚动增量 → 等距位移增量。
		const sample = async (target: number): Promise<number> => {
			scrollTop = target;
			el.dispatchEvent(new window.Event("scroll"));
			await flushFrames();
			const match = /^translate3d\(0(px)?, (\d+(?:\.\d+)?)px/.exec(v.style.transform);
			return match ? Number.parseInt(match[2], 10) : Number.NaN;
		};
		const at0 = await sample(0);
		const at100 = await sample(100);
		const at200 = await sample(200);
		const at300 = await sample(300);
		expect(at200 - at100).toBe(at100 - at0);
		expect(at300 - at200).toBe(at200 - at100);
		expect(at0).toBe(0);
	});

	test("拖拽双向可用：往下拖到底再往上拖回顶", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		const shown = rail();
		const v = verticalThumb(shown);
		// happy-dom has no layout engine, so the rail's rendered box is 0 and
		// the drag travel would compute as negative. Give it the box the
		// container reports.
		Object.defineProperty(shown, "offsetHeight", { configurable: true, get: () => rect.height });
		v.setPointerCapture = (): void => {};
		v.releasePointerCapture = (): void => {};
		v.hasPointerCapture = (): boolean => true;

		scrollTop = 200;
		v.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, clientY: 0, pointerId: 1 }));
		// 拇指 1:1 跟手：往上挪 10px，滚动距离按同比例回退，而不是被钳到顶。
		// vTrack = 100-8 = 92, vLen = 24 → travel = 68; vRange = 400
		// → scale = 0.17。10px 位移 = 10/0.17 ≈ 58.8px 滚动距离。
		v.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientY: -10, pointerId: 1 }));
		expect(Math.round(scrollTop)).toBe(Math.round(200 - 10 / 0.17));

		// 拖过整条轨道仍能到两端。
		v.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientY: 10_000, pointerId: 1 }));
		expect(Math.round(scrollTop)).toBe(400);
		v.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true, clientY: -10_000, pointerId: 1 }));
		expect(Math.round(scrollTop)).toBe(0);
	});

	test("切换皮肤后轨仍作用于可见节点（用户：换样式后卡在最顶上）", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		const before = rail();
		const vBefore = verticalThumb(before);

		localStorage.setItem("musepi-gui-scrollbar-style", "builtin-pacman");
		window.dispatchEvent(new Event("omp-scrollbar-style-changed"));
		await act(async () => {
			await Promise.resolve();
		});
		await flushFrames();

		// The skin change swaps the slot's whole subtree, so the rail must
		// re-resolve its elements. Writing transforms to the detached ones
		// left the visible thumb at its CSS default — pinned to the top.
		const after = rail();
		expect(after.dataset.base).toBe("pacman");
		const pac = after.querySelector<HTMLElement>(".gfs-pac");
		expect(pac).not.toBeNull();
		expect(before.contains(pac!)).toBe(true);

		// And it still tracks the container. React reconciles the two bases'
		// markup by index, so the old node is REUSED with a new class rather
		// than detached — which is why the rail kept writing the pac-man's
		// transform onto the thread element while the glyph sat at `top: 0`.
		scrollTop = 300;
		el.dispatchEvent(new window.Event("scroll"));
		await flushFrames();
		const shown = rail();
		const pacAfter = shown.querySelector<HTMLElement>(".gfs-pac")!;
		expect(pacAfter.style.transform).toMatch(/,\s*\d+px/);
		expect(vBefore).not.toBe(pacAfter);
	});

	test("吃豆人：豆子条常驻满轨，pac 随进度移动，已吃段与 pac 同步（用户：pac 卡在顶部）", async () => {
		localStorage.setItem("musepi-gui-scrollbar-style", "builtin-pacman");
		window.dispatchEvent(new Event("omp-scrollbar-style-changed"));
		await act(async () => {
			await Promise.resolve();
		});
		await flushFrames();

		const el = mountScroller();
		rect = { top: 0, left: 0, width: 100, height: 400, right: 100 };
		userScroll(el);
		await flushFrames();

		const shown = rail();
		expect(shown.dataset.base).toBe("pacman");
		// The bead rail is the persistent track: it is a full-height element and
		// never carries a progress transform.
		const beads = shown.querySelector<HTMLElement>(".gfs-beads")!;
		const eaten = shown.querySelector<HTMLElement>(".gfs-beads-eaten")!;
		const pac = shown.querySelector<HTMLElement>(".gfs-pac")!;
		expect(beads.style.transform).toBe("");

		// The glyph travels, and where it stops the eaten run ends with it.
		// Both come from one progress scalar, so they cannot drift apart.
		const readProgress = (el2: HTMLElement): number => {
			const m = /scaleY\(([\d.]+)\)/.exec(el2.style.transform);
			return m ? Number.parseFloat(m[1]) : Number.NaN;
		};
		const pacOffset = (el2: HTMLElement): number => {
			const m = /translate3d\(0(?:px)?, (-?[\d.]+)px/.exec(el2.style.transform);
			return m ? Number.parseFloat(m[1]) : Number.NaN;
		};

		scrollTop = 200; // half of the 400px range
		el.dispatchEvent(new window.Event("scroll"));
		await flushFrames();

		expect(pac.style.transform).not.toBe("");
		expect(pacOffset(pac)).toBeGreaterThan(0);
		expect(readProgress(eaten)).toBeCloseTo(0.5, 5);
		// Glyph travel = progress × (track − glyph), so at half the glyph sits at
		// half of ITS travel — not pinned at the top, not past the end.
		const track = 400 - 2 * 4;
		expect(pacOffset(pac)).toBeCloseTo(0.5 * (track - 12), 0);

		// At the bottom the glyph's own edge reaches the end of the rail.
		scrollTop = 400;
		el.dispatchEvent(new window.Event("scroll"));
		await flushFrames();
		expect(readProgress(eaten)).toBeCloseTo(1, 5);
		expect(pacOffset(pac)).toBeCloseTo(track - 12, 0);
	});

	test("一帧内再多的内容变动也只测一次（用户：滚轮滚动时卡顿、尺度抖动）", async () => {
		const el = mountScroller();
		el.appendChild(document.createElement("div"));
		userScroll(el);
		await flushFrames();
		const observer = TestResizeObserver.instances.find(o => o.observed().length > 0);
		expect(observer).toBeDefined();

		// A virtualizer swapping rows reports a size change per row, and a row
		// swap also shifts the scroll range. Each report used to measure
		// synchronously — a rect read plus an ancestor z walk — so the rail
		// re-derived its scroll-range scale dozens of times per scroll frame and
		// the thumb drifted against a steady scroll. Fifty reports in one frame
		// must collapse to a single measure.
		verticalLayoutReads = 0;
		for (let i = 0; i < 50; i += 1) {
			scrollHeight = 500 + (i % 5);
			observer!.trigger();
		}
		// Flush synchronously: awaiting would yield to the event loop, and the
		// overlay's 600ms liveness probe could land inside the window and add a
		// read that has nothing to do with coalescing.
		for (const callback of Array.from(pendingFrames.values())) callback(0);
		pendingFrames.clear();

		expect(verticalLayoutReads).toBe(1);

		// The next frame measures again — coalescing must not go deaf.
		observer!.trigger();
		for (const callback of Array.from(pendingFrames.values())) callback(0);
		pendingFrames.clear();
		expect(verticalLayoutReads).toBe(2);
	});

	test("同一帧内两个容器滚动，各自的 rAF 合并后两条轨都指向最新容器", async () => {
		const a = mountScroller();
		const b = mountScroller();
		rect = { top: 0, left: 0, width: 100, height: 100, right: 200 };
		userScroll(a);
		userScroll(b);
		await flushFrames();

		// 两条轨都活着（池契约），而不是只剩一个 target。
		expect(host.querySelectorAll(".gui-float-scrollbar[data-visible]").length).toBe(2);
	});

	test("比例拇指：内容越长拇指越短，但不低于最小可抓尺寸", async () => {
		// Track long enough that the visible ratio, not the 24px floor, decides
		// the thumb — otherwise both cases collapse to the same minimum.
		rect = { top: 0, left: 0, width: 100, height: 400, right: 100 };
		const el = mountScroller();
		scrollHeight = 800;
		userScroll(el);
		await flushFrames();
		const shorter = parseFloat(verticalThumb(rail()).style.height);

		// Retire, then re-bind with much longer content: same 400px track, a
		// 1.25% visible ratio. Content-shrink is detected by the observers and
		// the probe, not by the scroll pass, so wait for one.
		scrollHeight = clientHeight;
		await waitForProbe();
		scrollHeight = 8000;
		userScroll(el);
		await flushFrames();
		const longest = parseFloat(verticalThumb(rail()).style.height);

		expect(longest).toBeLessThan(shorter);
		// Still grabbable at the floor.
		scrollHeight = clientHeight * 400;
		await waitForProbe();
		userScroll(el);
		await flushFrames();
		expect(parseFloat(verticalThumb(rail()).style.height)).toBeGreaterThanOrEqual(24);
	});
});

describe("FloatingScrollbar 水平轴", () => {
	test("横向溢出时出现比例拇指并随 scrollLeft 移动", async () => {
		scrollWidth = 800;
		const el = mountScroller();
		userScroll(el);
		await flushFrames();

		const h = horizontalThumb(rail());
		const width = parseFloat(h.style.width);
		expect(width).toBeGreaterThan(0);
		expect(width).toBeLessThan(100);

		scrollLeft = 700;
		el.dispatchEvent(new window.Event("scroll"));
		await flushFrames();

		// Moved along the horizontal track, and by transform alone.
		const moved = horizontalThumb(rail()).style.transform;
		expect(moved).toMatch(/^translate3d\((\d+)px, 0(px)?, 0(px)?\)$/);
		expect(Number.parseInt(moved.match(/translate3d\((\d+)px/)![1], 10)).toBeGreaterThan(0);
		expect(horizontalThumb(rail()).style.left).toBe("");
	});

	test("被裁剪的溢出不算溢出：只横向可滚的 tab 条不长出纵向拇指", async () => {
		// 复刻右栏 tab 条：横向滚动，纵向 `overflow-y: hidden` 把 6px 下内边距
		// 之外的 chip 裁掉。scrollHeight 仍然报告这段被裁掉的溢出，只看尺寸差
		// 就会凭空画一条永远拖不动的纵向轨，压在标签的关闭按钮上。
		scrollWidth = 400;
		scrollHeight = 132;
		clientHeight = 124;
		clientWidth = 100;
		const el = mountScroller({ overflowY: "hidden", overflowX: "auto" });
		userScroll(el);
		await flushFrames();

		const r = rail();
		expect(parseFloat(verticalThumb(r).style.height)).toBe(0);
		expect(parseFloat(horizontalThumb(r).style.width)).toBeGreaterThan(0);
	});

	test("两轴都被裁剪的容器不生成轨", async () => {
		const el = mountScroller({ overflowY: "hidden", overflowX: "hidden" });
		userScroll(el);
		await flushFrames();

		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).toBeNull();
	});

	test("没有横向溢出时不显示横向拇指", async () => {
		scrollWidth = clientWidth;
		const el = mountScroller();
		userScroll(el);
		await flushFrames();

		expect(parseFloat(horizontalThumb(rail()).style.width)).toBe(0);
	});
});

describe("FloatingScrollbar 交互可见性", () => {
	test("程序化滚动不点亮轨，滚轮滚动点亮", async () => {
		const el = mountScroller();
		programmaticScroll(el);
		await flushFrames();
		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).toBeNull();

		userScroll(el);
		await flushFrames();
		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).not.toBeNull();
	});

	test("滚动按键（PageDown 等）使随后的滚动被认作用户意图", async () => {
		const el = mountScroller();
		document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
		programmaticScroll(el);
		await flushFrames();

		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).not.toBeNull();
	});

	test("始终显示只决定已点亮轨是否淡出，不决定哪些容器有轨；且关掉后必定恢复淡出", async () => {
		// 派发必须包在 act 里：saveAlwaysShowScrollbar 触发的是 React 状态更新，
		// 在 act 作用域外派发会等到 act 退出时才 flush，那 1000ms 的 idle 定时器
		// 会在断言之后才武装。
		await act(async () => {
			saveAlwaysShowScrollbar(true);
		});
		expect(readAlwaysShowScrollbar()).toBe(true);
		await flushFrames();

		// 常显不是「发现模式」。一个从未被手势滚动过的容器即使发生程序性
		// 滚动也不生成轨——否则这个开关会往隐藏的、嵌套的容器上凭空挂轨，
		// 把 6 个槽位占满后每条轨都不再淡出。
		const untouched = mountScroller();
		programmaticScroll(untouched);
		await flushFrames();
		expect(host.querySelector(".gui-float-scrollbar[data-visible]")).toBeNull();

		// 真实手势才开轨，且常显期间保持常亮（越过 HIDE_MS 也不进 idle）。
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 1200));
		});
		expect(rail().dataset.visible).toBe("1");
		expect(rail().dataset.idle).toBeUndefined();

		// 关掉开关必须真的重新淡出，即使残留一个没有配对 leave 的 pointerenter
		// 让 overContainer 卡在 true。修复前 armIdle 会在这里直接 return，
		// 轨一直亮到重启才消失。
		await act(async () => {
			el.dispatchEvent(new window.PointerEvent("pointerenter", { bubbles: false }));
			saveAlwaysShowScrollbar(false);
		});
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 1200));
		});
		expect(rail().dataset.idle).toBe("1");
	});

	test("滚动停止后进入 idle 淡出态，轨仍然存在（拖拽把手不被销毁）", async () => {
		const el = mountScroller();
		userScroll(el);
		await flushFrames();
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 1200));
		});

		const el2 = rail();
		expect(el2.dataset.idle).toBe("1");
		expect(el2.dataset.visible).toBe("1");
	});
});

describe("FloatingScrollbar 层叠", () => {
	test("轨的 z-index 跟随容器层级，重新测量时刷新（不缓存过期值）", async () => {
		const layer = document.createElement("div");
		layer.style.position = "relative";
		layer.style.zIndex = "10";
		document.body.appendChild(layer);
		const inner = mountScroller({ parent: layer });

		userScroll(inner);
		await flushFrames();
		const zLow = rail().style.zIndex;
		expect(Number(zLow)).toBe(11);

		// 祖先层级在运行时变化（弹窗 / 提示条打开）。层级解析不做缓存，
		// 所以任何一次重新测量都会跟上新值，而不是沿用首次算出的数字。
		layer.style.zIndex = "840";
		// 容器自身几何变化触发重新测量（真实场景：侧栏折叠、面板最大化）。
		rect = { top: 0, left: 0, width: 100, height: 120, right: 100 };
		window.dispatchEvent(new window.Event("resize"));
		await flushFrames();
		const zHigh = rail().style.zIndex;

		expect(Number(zHigh)).toBe(841);
		expect(Number(zHigh)).toBeGreaterThan(Number(zLow));
		layer.remove();
	});
});
