import type { RefObject } from "react";
import { useEffect } from "react";

/**
 * 滚动容器边缘羽化(scroll edge feather)的共享机制。
 *
 * 一个机制,两个方向:监听滚动容器,把四个方向的"内容是否溢出且滚离
 * 边缘"写成 `data-top-scroll` / `data-bottom-scroll` /
 * `data-left-scroll` / `data-right-scroll` 属性;CSS mask-image 规则按
 * 属性挂渐变(纵向上下羽化、横向左右羽化),只在对应方向真实可滚动时
 * 显示。桌面端 transcript / 会话列表 / 设置面板与消息内 markdown 表格 /
 * 代码块同配方(openchamber ScrollShadow parity)。
 *
 * - `attachScrollShadow` / `useScrollShadow`:单一容器(桌面端原有
 *   use-scroll-shadow 的归家实现,desktop-app 从这里 re-export)。
 * - `useDeepScrollShadow`:容器树深扫描——给 raw-HTML 渲染区(markdown
 *   表格 / 代码块 / KaTeX / mermaid)和一棵子树里的多个滚动容器统一
 *   挂羽化,DOM 变更(MutationObserver, RAF 节流)时增量补挂 / 清理。
 *
 * 为什么用 JS 判向而不是 CSS scroll-state container queries:既有实现
 * 就是 JS data-attr 配方(见上),全仓库统一跟既有;且 raw-HTML 容器
 * 也走同一套属性,CSS 只需一份。
 */

/** 边缘判定阈值(px):滚动位置距边缘 ≤ 阈值视为"贴在边缘",不羽化。 */
export const SCROLL_EDGE_THRESHOLD = 8;

export interface ScrollEdgeMetrics {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
	scrollLeft: number;
	clientWidth: number;
	scrollWidth: number;
}

export interface ScrollEdgeState {
	top: boolean;
	bottom: boolean;
	left: boolean;
	right: boolean;
}

/**
 * 由滚动几何算出四方向羽化状态。纯函数:内容不溢出时四个方向全是
 * false(scrollTop/scrollLeft 恒为 0,scrollHeight==clientHeight),
 * 所以"只在可滚动时显示羽化"不需要额外判断。
 */
export function computeScrollEdgeState(m: ScrollEdgeMetrics): ScrollEdgeState {
	return {
		top: m.scrollTop > SCROLL_EDGE_THRESHOLD,
		bottom: m.scrollTop + m.clientHeight < m.scrollHeight - SCROLL_EDGE_THRESHOLD,
		left: m.scrollLeft > SCROLL_EDGE_THRESHOLD,
		right: m.scrollLeft + m.clientWidth < m.scrollWidth - SCROLL_EDGE_THRESHOLD,
	};
}

function applyScrollEdgeState(el: HTMLElement): ScrollEdgeState {
	const state = computeScrollEdgeState({
		scrollTop: el.scrollTop,
		clientHeight: el.clientHeight,
		scrollHeight: el.scrollHeight,
		scrollLeft: el.scrollLeft,
		clientWidth: el.clientWidth,
		scrollWidth: el.scrollWidth,
	});
	el.dataset.topScroll = String(state.top);
	el.dataset.bottomScroll = String(state.bottom);
	el.dataset.leftScroll = String(state.left);
	el.dataset.rightScroll = String(state.right);
	return state;
}

/**
 * 监听单个滚动容器,维护四方向 data 属性(见模块头)。scroll / resize /
 * 子树内容变化(流式输出、列表更新不改 scrollTop 但改 scrollHeight)
 * 都会重新测量。返回解绑函数。
 */
export function attachScrollShadow(el: HTMLElement, onMeasure?: (el: HTMLElement) => void): () => void {
	const measure = (): void => {
		if (!el.isConnected) return;
		applyScrollEdgeState(el);
		onMeasure?.(el);
	};
	el.addEventListener("scroll", measure, { passive: true });
	const ro = new ResizeObserver(measure);
	ro.observe(el);
	// 内容增长(流式 / 列表更新)不改 scrollTop 也触不到 ResizeObserver
	// (容器尺寸没变)——子树变更 RAF 节流补测。只看 childList,不观察
	// attribute:我们自己写 data 属性,观察 attribute 会自激循环。
	let raf = 0;
	const mo = new MutationObserver(() => {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(measure);
	});
	mo.observe(el, { childList: true, subtree: true });
	const onVis = (): void => {
		if (document.visibilityState === "visible") measure();
	};
	document.addEventListener("visibilitychange", onVis);
	measure();
	return () => {
		el.removeEventListener("scroll", measure);
		ro.disconnect();
		mo.disconnect();
		cancelAnimationFrame(raf);
		document.removeEventListener("visibilitychange", onVis);
	};
}

/**
 * `attachScrollShadow` 的 hook 形态。容器可能晚于 effect 挂载(条件渲染:
 * 浮层、菜单),也可能开关时被整体替换——200ms 轮询在元素变化时重新订阅,
 * 缺失期间开销可忽略。
 */
export function useScrollShadow(rootRef: RefObject<HTMLElement | null>, onMeasure?: (el: HTMLElement) => void): void {
	useEffect(() => {
		let cleanup: (() => void) | undefined;
		let lastEl: HTMLElement | null = rootRef.current;
		const setup = (root: HTMLElement): void => {
			cleanup = attachScrollShadow(root, onMeasure);
		};
		if (lastEl) setup(lastEl);
		const iv = window.setInterval(() => {
			const el = rootRef.current;
			if (el === lastEl) return;
			cleanup?.();
			lastEl = el;
			if (el) setup(el);
		}, 200);
		return () => {
			window.clearInterval(iv);
			cleanup?.();
		};
	}, [rootRef, onMeasure]);
}

/**
 * 深扫描形态:给 `rootRef` 自身及子树里所有匹配 `selector` 的元素挂
 * 羽化,之后 DOM 变更(RAF 节流)时增量补挂新出现的容器、解绑已摘除的
 * 容器。用于 raw-HTML 渲染区(markdown 表格 / 代码块 / KaTeX / mermaid,
 * React 拿不到每个内部元素的 ref)和一棵子树里散落多个横向滚动容器的
 * 面板(右栏 workspace / 扩展中心)。
 */
export function useDeepScrollShadow(rootRef: RefObject<HTMLElement | null>, selector: string): void {
	useEffect(() => {
		let disposed = false;
		let cleanupIv = 0;
		const attached = new Map<Element, () => void>();

		const scan = (): void => {
			if (disposed) return;
			const root = rootRef.current;
			if (!root) return;
			for (const [el, detach] of attached) {
				if (el === root ? !el.isConnected : !el.isConnected || !root.contains(el)) {
					detach();
					attached.delete(el);
				}
			}
			if (!attached.has(root)) attached.set(root, attachScrollShadow(root));
			for (const el of root.querySelectorAll<HTMLElement>(selector)) {
				if (!attached.has(el)) attached.set(el, attachScrollShadow(el));
			}
		};

		let raf = 0;
		const scheduleScan = (): void => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(scan);
		};

		const mos: MutationObserver[] = [];
		// 根可能晚挂载(条件渲染 / 浮层):轮询到出现为止;出现后靠
		// MutationObserver 捕获后续容器增删,不再依赖轮询。
		cleanupIv = window.setInterval(() => {
			const root = rootRef.current;
			if (!root) return;
			window.clearInterval(cleanupIv);
			cleanupIv = 0;
			scan();
			const mo = new MutationObserver(scheduleScan);
			mo.observe(root, { childList: true, subtree: true });
			mos.push(mo);
		}, 200);
		scan();

		return () => {
			disposed = true;
			if (cleanupIv) window.clearInterval(cleanupIv);
			cancelAnimationFrame(raf);
			for (const mo of mos) mo.disconnect();
			for (const detach of attached.values()) detach();
			attached.clear();
		};
	}, [rootRef, selector]);
}
