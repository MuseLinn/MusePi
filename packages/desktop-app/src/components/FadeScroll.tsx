import type { MouseEventHandler, ReactNode } from "react";
import { useRef } from "react";
import { useScrollShadow } from "../lib/use-scroll-shadow";

/**
 * 内容边界羽化容器(边缘渐变淡出):通用版 useScrollShadow 载体——把
 * `overflow-y-auto` / `overflow-x-auto` 等滚动类容器包进来,内部维护
 * `data-top-scroll`/`data-bottom-scroll`/`data-left-scroll`/`data-right-scroll`,
 * CSS(`.gui-fade-scroll[data-*]`)在内容真实溢出且滚离边缘时才挂 mask:
 * 纵向容器上下羽化、横向容器(如欢迎页 chip 排)左右羽化(openchamber
 * ScrollShadow parity,与 transcript / 会话列表 / 消息内表格同配方)。
 * 注意单方向使用:mask-image 不可双轴叠加。
 *
 * 用于没有专用 class 的泛化滚动容器(右栏 tab 体、轨迹列表、git/diff/pr
 * 面板、向导/引导/导入列表等)——此前这类容器全部漏做羽化(2026-08-21 审计)。
 */
export function FadeScroll({
	className,
	children,
	onMeasure,
	onClick,
	scrollRef,
}: {
	className?: string;
	children: ReactNode;
	/** 透传给 useScrollShadow(每次 scroll/resize/mutation 后回调)。 */
	onMeasure?: (el: HTMLElement) => void;
	/** 透传给容器(浮层自弹窗需要 stopPropagation 时用)。 */
	onClick?: MouseEventHandler<HTMLDivElement>;
	/** 可选滚动容器句柄(轨迹 Overview 区间 → 列表跳转用)。 */
	scrollRef?: (el: HTMLDivElement | null) => void;
}): ReactNode {
	const ref = useRef<HTMLDivElement | null>(null);
	useScrollShadow(ref, onMeasure);
	return (
		<div
			ref={el => {
				ref.current = el;
				scrollRef?.(el);
			}}
			className={`gui-fade-scroll ${className ?? ""}`}
			onClick={onClick}
		>
			{children}
		</div>
	);
}
