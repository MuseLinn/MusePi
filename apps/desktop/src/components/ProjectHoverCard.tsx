import { t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../vendor/oc-icons";

/**
 * 项目行悬浮卡:一张项目条目能看全它名下的每个目录。
 *
 * 项目支持多根目录(`WorkspaceProject.root` + `additionalDirs`),但侧栏项目
 * 行只写一个名字 —— 用户看不出「这个项目其实铺在几个文件夹上」。悬停项目块
 * 即浮出一张 240px 卡片,列出主目录 + 每个附加目录、会话数与打开动作。
 *
 * **位置:侧栏右侧、与悬停行顶对齐**——卡片不在侧栏里,所以不遮挡下面的
 * 会话行;右侧放不下才翻到侧栏左侧。纵向贴行顶向下生长,下方装不下就改为
 * 向上生长。
 *
 * **为什么 portal 到 body**:侧栏链路上有 `backdrop-filter`
 * (`.gui-main`、侧栏卡片表面),含 transform/filter/backdrop-filter 的祖先
 * 会成为 `position: fixed` 的包含块,于是卡片的 `left`/`top` 不再是视口坐标,
 * 还会被中途的 `overflow: hidden` 裁掉;而在块内用 `absolute` 则只能压在
 * 侧栏上、并被 `.gui-sessions-list` 的滚动裁剪。portal 出这条链路后,卡片
 * 的坐标就是视口坐标,滚动容器也碰不到它 —— 与会话悬浮卡同一结论。
 *
 * **包含关系由状态而非 DOM 承担**:卡片离开块的 DOM 子树后,块的
 * `mouseleave`/`blur` 不再覆盖它,所以卡片自己接管指针进入(取消收卡)、离开
 * (重新计时),块的处理器则把「落点在卡片内」的离开判为没有离开。Tab 进卡由
 * 两端的显式交棒完成(见 {@link firstCardFocusable} / {@link lastFocusable}),
 * 因为 portal 节点在 body 末尾,原生 Tab 顺序够不到它。
 *
 * **高度随目录数增长,适配按实测几何算**:64 个目录的卡片在 800px 高的窗口里
 * 接近 1.4k px,任何固定阈值都装不下。挂载后先量出卡片真实几何(见
 * {@link measureCard}),交给 {@link fitProjectCard} 决定翻不翻、列表能有多高,
 * 再把列表的 `max-height` 夹到真实可用空间(装不下就让列表自己滚)。常量只是
 * **首帧估值**:测量在绘制前的 layout effect 里完成,用户看到的第一帧已经按
 * 实测值算过。
 *
 * 只滚一个轴就必须显式声明另一个轴(见 `gui-chrome.css` 的
 * `.gui-project-hover-card-list`):目录行是 `nowrap` + 省略号 + 全路径
 * `title`,列表永远不该横向滚。
 */

/**
 * 卡片除目录列表之外的固定高度 —— **仅作首帧的估值**,挂载后立刻用实测替换。
 *
 * 数值来自随发布版的字号阶梯(`tokens.css` 的 `--ui-font-size` 15px /
 * `--ui-font-size-xs` 13px),不是测试夹具那套 11px/13px:
 * Chromium 实测(卡片宽 / 语言 → 卡片高 − 列表高)
 *  - 152px(168 侧栏)/ en → 91.25  ← 最坏:「11 个目录 · 4 个会话」折两行(39 vs 19.5)
 *  - 152px 或 164px / zh → 71.75
 *  - 224px、240px / 任一  → 71.75
 *
 * 这组数字只保证首帧不差太远:实测(`measureCard`)在 useLayoutEffect 里跑在
 * 首次绘制之前,真实的 chrome 与行高会回灌给 {@link fitProjectCard},所以
 * 翻转方向与列表上限用的是真值,而不是这套估值。字号被放大、语言换掉、主题
 * 改行高都不再依赖常量正确。 */
export const CARD_CHROME_HEIGHT = 92;
/** 目录列表自身的高度上限:`min(280px, 50vh)`(见 `gui-chrome.css`)。 */
export const LIST_MAX_HEIGHT = 280;
/** 一行目录的步进(行高 + 1px 行间距)。实测值同上:随发布版阶梯为 26.8 行高 /
 *  27.8 步进;这里的 28 同样是首帧估值。 */
export const ROW_HEIGHT = 28;
/** 卡片宽度 —— 与 `gui-chrome.css` 的 `width: 240px` 同一事实,定位需要它。 */
export const CARD_WIDTH = 240;
/** 卡片与侧栏之间的空隙(以及翻到左侧时的同一空隙)。 */
export const CARD_GAP = 8;
/** 卡片贴视口边缘时至少留出的空隙,不顶到窗口边上。 */
const EDGE_INSET = 8;

export interface CardFit {
	/** 贴行上方生长(`--above`)。 */
	above: boolean;
	/** 列表实际可用的高度(像素)—— 永远不超过真实可占空间。 */
	listMax: number;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/**
 * 卡片该往上翻还是往下贴,以及列表能分到多高。
 *
 * 纯函数,便于单测:不读 DOM、不读视口。
 *
 * 顺序:先算「首选高度」(列表按 `min(目录数×行高, listMax)`);下方装得下就
 * 贴行顶向下;否则翻到更宽裕的一侧;最后把列表夹进那一侧的可用空间(扣掉
 * 卡片固定部分)——装不下就滚动,而不是让卡片溢出被裁。
 */
export function fitProjectCard({
	directoryCount,
	spaceBelow,
	spaceAbove,
	listMax = LIST_MAX_HEIGHT,
	chromeHeight = CARD_CHROME_HEIGHT,
	rowHeight = ROW_HEIGHT,
}: {
	directoryCount: number;
	spaceBelow?: number;
	spaceAbove?: number;
	listMax?: number;
	/** 卡片固定部分的高度。挂载实测后回灌,不传则用常量估值。 */
	chromeHeight?: number;
	/** 一行目录的步进(行高 + 间距)。同上。 */
	rowHeight?: number;
}): CardFit {
	const naturalList = Math.min(Math.max(directoryCount, 0) * rowHeight, listMax);
	const natural = chromeHeight + naturalList;
	// 没有测量信息(测试/首帧)时按首选方向贴下沿。
	if (spaceBelow === undefined && spaceAbove === undefined) {
		return { above: false, listMax: naturalList };
	}

	const below = Math.max(0, (spaceBelow ?? 0) - EDGE_INSET);
	const above = Math.max(0, (spaceAbove ?? 0) - EDGE_INSET);
	// 首选:下方装得下就贴行顶向下。否则翻到更宽裕的一侧——装得下就整张放进去,
	// 都装不下就选装得更多的那侧,由 listMax 把列表夹进剩余空间(滚动可达)。
	//
	// 注意这里 listMax 恒等于 min(room − chrome, natural),所以
	// 「chrome + listMax ≤ room」在夹取分支里**对任何 chrome 都成立**。也就是说
	// 扫描只能证明决策形状自洽,证明不了常量是对的——常量靠挂载实测来纠偏。
	const flip = natural > below && above > below;
	const room = flip ? above : below;
	return { above: flip, listMax: clamp(room - chromeHeight, 0, naturalList) };
}

/** 悬停项目行的视口矩形(只需纵向边,横向由侧栏决定)。 */
interface ProjectRowRect {
	top: number;
	bottom: number;
}

/** 侧栏的视口矩形 —— 卡片贴在它的外侧。 */
export interface SidebarRect {
	left: number;
	right: number;
}

interface ProjectAnchor {
	row: ProjectRowRect;
	sidebar: SidebarRect;
}

export interface CardPlacement {
	/** 卡片左缘(视口坐标)。 */
	left: number;
	/** 翻到了侧栏左侧(右侧放不下)。 */
	flipped: boolean;
}

/**
 * 卡片该站在侧栏哪一侧。
 *
 * 首选永远是右侧(`sidebar.right + gap`)——用户要在侧栏之外看这张卡,而不是
 * 让它盖住自己的列表。只有右侧真放不下、且左侧放得下时才翻到左侧;两侧都
 * 放不下时留在右侧并夹进视口(窗口窄于侧栏 + 卡片时,无论如何都会压住点
 * 东西,压聊天区好过压侧栏本身)。
 */
export function placeProjectCard({
	sidebar,
	viewportWidth,
	width = CARD_WIDTH,
	gap = CARD_GAP,
	inset = EDGE_INSET,
}: {
	sidebar: SidebarRect;
	viewportWidth: number;
	width?: number;
	gap?: number;
	inset?: number;
}): CardPlacement {
	const right = sidebar.right + gap;
	const leftSide = sidebar.left - gap - width;
	const fitsRight = right + width <= viewportWidth - inset;
	const fitsLeft = leftSide >= inset;
	const flipped = !fitsRight && fitsLeft;
	const preferred = flipped ? leftSide : right;
	return {
		left: clamp(preferred, inset, Math.max(inset, viewportWidth - inset - width)),
		flipped,
	};
}

const FOCUSABLE =
	'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** 卡片里的第一个可聚焦控件 —— 键盘从项目块进卡的落点。 */
export function firstCardFocusable(card: HTMLElement | null): HTMLElement | null {
	return card?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
}

/** 元素子树里最后一个可聚焦控件 —— Tab 交棒前的「块内最后一站」。 */
export function lastFocusable(root: HTMLElement | null): HTMLElement | null {
	const all = root?.querySelectorAll<HTMLElement>(FOCUSABLE);
	return all && all.length > 0 ? (all[all.length - 1] ?? null) : null;
}

/** 挂载实测:卡片固定部分的高度与一行目录的步进。 */
export interface CardMetrics {
	chrome: number;
	row: number;
}

/** 读一次真实布局。取不到(未布局 / happy-dom)时返回 null。 */
export function measureCard(card: HTMLElement | null): CardMetrics | null {
	if (!card) return null;
	const list = card.querySelector<HTMLElement>(".gui-project-hover-card-list");
	if (!list) return null;
	const cardHeight = card.getBoundingClientRect().height;
	// 未布局时为 0,读数不可信。
	if (cardHeight <= 0) return null;
	const chrome = cardHeight - list.getBoundingClientRect().height;
	const rows = list.querySelectorAll<HTMLElement>(".gui-project-hover-card-row");
	if (rows.length === 0) return null;
	const row =
		rows.length > 1
			? rows[1]!.getBoundingClientRect().top - rows[0]!.getBoundingClientRect().top
			: rows[0]!.getBoundingClientRect().height;
	if (!(chrome > 0) || !(row > 0)) return null;
	return { chrome, row };
}

export interface ProjectHoverCardProps {
	/** 项目显示名(按重名规则加宽)。 */
	name: string;
	/** 项目的每个工作目录,主目录(root)在前。 */
	directories: readonly {
		path: string;
		/** 项目主目录(root)—— 其余都是附加目录。 */
		primary: boolean;
	}[];
	/** 该项目的会话数(项目行右侧计数的同一口径)。 */
	sessionCount: number;
	/** 该目录的文件夹名 —— 展示用,全路径留在 title。 */
	labelOf(path: string): string;
	/** 打开该目录(资源管理器 / Finder / 文件管理器)。 */
	onOpenDirectory?(path: string): void;
	/** OS 打开动作的名称随 shell 走(资源管理器 ≠ Finder)。 */
	openLabel: string;
	/** 悬停行与侧栏的视口矩形。缺省时卡片按 CSS 静态位置渲染(仅测试/首帧)。 */
	anchor?: ProjectAnchor;
	/** 指针进入卡片 —— 取消块的收卡计时。 */
	onPointerEnter?(): void;
	/** 指针离开卡片 —— 重新开始收卡计时。 */
	onPointerLeave?(): void;
	/** Shift+Tab 从卡的第一个控件退出时,把焦点交回项目块。 */
	onRequestReturnFocus?(): void;
	/** 块 → 卡的 Tab 交棒需要拿到卡片元素。 */
	cardRef?: (element: HTMLDivElement | null) => void;
}

export function ProjectHoverCard({
	name,
	directories,
	sessionCount,
	labelOf,
	onOpenDirectory,
	openLabel,
	anchor,
	onPointerEnter,
	onPointerLeave,
	onRequestReturnFocus,
	cardRef,
}: ProjectHoverCardProps): ReactNode {
	const localRef = useRef<HTMLDivElement | null>(null);
	// 挂载实测出来的真实几何。首帧用常量估值,`useLayoutEffect` 在绘制前跑完,
	// 所以用户看到的第一次定位就已经按实测算过;常量只是"还没量到"时的过渡值。
	const [metrics, setMetrics] = useState<CardMetrics | null>(null);
	// 视口只在浏览器里存在;SSR/无 DOM 时 anchor 也不会给出,退回静态渲染。
	const viewport = typeof window === "undefined" ? null : { width: window.innerWidth, height: window.innerHeight };
	const fit = fitProjectCard({
		directoryCount: directories.length,
		// 卡片已 portal 出滚动容器,可用空间只由视口与行决定。
		...(anchor && viewport
			? {
					spaceBelow: Math.max(0, viewport.height - anchor.row.bottom),
					spaceAbove: Math.max(0, anchor.row.top),
				}
			: {}),
		...(metrics ? { chromeHeight: metrics.chrome, rowHeight: metrics.row } : {}),
	});

	useLayoutEffect(() => {
		const next = measureCard(localRef.current);
		if (!next) return;
		// 只在读数真的变了才重渲染,避免每次父组件重渲染都触发一轮 setState。
		setMetrics(prev =>
			prev && Math.abs(prev.chrome - next.chrome) < 0.5 && Math.abs(prev.row - next.row) < 0.5 ? prev : next,
		);
	});

	const placement =
		anchor && viewport ? placeProjectCard({ sidebar: anchor.sidebar, viewportWidth: viewport.width }) : null;

	const style: CSSProperties = {
		"--gui-project-list-max": `${Math.max(0, fit.listMax)}px`,
	} as CSSProperties;
	if (placement) style.left = `${placement.left}px`;
	if (anchor && viewport) {
		// 向下:卡片顶边贴行顶。向上:卡片底边贴行顶 —— 用 `bottom` 而不是
		// `top`,这样卡片按自身高度向上生长,无需先量高度再定位。
		if (fit.above) style.bottom = `${Math.max(0, viewport.height - anchor.row.top)}px`;
		else style.top = `${Math.max(0, anchor.row.top)}px`;
	}

	const card = (
		<div
			ref={element => {
				localRef.current = element;
				cardRef?.(element);
			}}
			className={`gui-project-hover-card${fit.above ? " gui-project-hover-card--above" : ""}`}
			style={style}
			role="group"
			aria-label={name}
			onMouseEnter={onPointerEnter}
			onMouseLeave={onPointerLeave}
			onKeyDown={event => {
				// 卡的第一个控件 Shift+Tab 回到项目块:portal 节点在 body 末尾,
				// 原生顺序回不去,必须显式交棒。
				if (event.key !== "Tab" || !event.shiftKey) return;
				if (event.target !== firstCardFocusable(localRef.current)) return;
				if (!onRequestReturnFocus) return;
				event.preventDefault();
				onRequestReturnFocus();
			}}
		>
			<div className="gui-project-hover-card-title" title={name}>
				{name}
			</div>
			<div className="gui-project-hover-card-meta">
				<Icon name="folder" className="gui-project-hover-card-icon" />
				<span>
					{directories.length === 1
						? t("general.projectDirectoryOne")
						: t("general.projectDirectoryCount", { count: directories.length })}
				</span>
				<span className="gui-project-hover-card-dot" aria-hidden="true" />
				<span>
					{sessionCount === 1
						? t("settings.sessionCountOne")
						: t("settings.sessionCountLabel", { count: sessionCount })}
				</span>
			</div>
			<ul className="gui-project-hover-card-list">
				{directories.map(directory => (
					<li key={directory.path} className="gui-project-hover-card-row">
						<Icon name={directory.primary ? "folder-shared" : "folder"} className="gui-project-hover-card-icon" />
						<span className="gui-project-hover-card-text" title={directory.path}>
							{labelOf(directory.path)}
						</span>
						{directory.primary && (
							<span className="gui-project-hover-card-chip">{t("settings.primaryDirectory")}</span>
						)}
						{onOpenDirectory && (
							<button
								type="button"
								className="gui-project-hover-card-open"
								title={`${openLabel}: ${directory.path}`}
								aria-label={`${openLabel}: ${directory.path}`}
								onClick={event => {
									event.stopPropagation();
									onOpenDirectory(directory.path);
								}}
							>
								<Icon name="folder-open" className="h-3 w-3" />
							</button>
						)}
					</li>
				))}
			</ul>
		</div>
	);

	// SSR/首帧没有 body 时退回内联渲染(happy-dom 单测以外不会发生)。
	if (typeof document === "undefined") return card;
	return createPortal(card, document.body);
}
