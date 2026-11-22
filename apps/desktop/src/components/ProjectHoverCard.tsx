import { t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * 项目行悬浮卡:一张项目条目能看全它名下的每个目录。
 *
 * 项目支持多根目录(`WorkspaceProject.root` + `additionalDirs`),但侧栏项目
 * 行只写一个名字 —— 用户看不出「这个项目其实铺在几个文件夹上」。悬停项目块
 * 即浮出一张 240px 卡片,列出主目录 + 每个附加目录、会话数与打开动作。
 *
 * 与 `SessionHoverCard` 的两处关键差别:
 * - **不用模块级 bus**:卡片就是项目块内的一个子元素,由块自身的 hover /
 *   focus 状态控制(见 `SessionSidebar` 的项目块)。总线只适合"同一时刻只有
 *   一行"的会话行;项目块数量少,就地持有状态才能让键盘真正走进去。
 * - **不 portal,且**渲染在 `.gui-project-block` **内部**:会话卡必须 portal
 *   是因为侧栏链路的 backdrop-filter 会劫持 fixed 定位;本卡
 *   `position: absolute` 相对已定位的 `.gui-project-block`(`position:
 *   relative`)定位,`top:100%` 就是那一行的下沿。放在块内而不是块后面的
 *   兄弟位置,是为了让「块→卡」的指针移动与 Tab 进卡都还在块的
 *   mouseleave / blur 包含关系内(否则卡片会被 120ms 宽限当场收掉),也让
 *   卡片避开 `ProjectCollapse` 的 `overflow:hidden` 与列表滚动容器的裁剪。
 *
 * **高度随目录数增长,适配按实测几何算**:64 个目录的卡片在 800px 高的窗口里
 * 接近 1.4k px,任何固定阈值都装不下,会被滚动容器裁掉——而卡片又在滚动时
 * 收起,裁掉的部分再也够不到。所以挂载后先量出卡片真实几何(见 `measureCard`),
 * 交给 {@link fitProjectCard} 决定翻不翻、列表能有多高,再把列表的 `max-height`
 * 夹到真实可用空间(装不下就让列表自己滚)。常量只是**首帧估值**:测量在绘制前
 * 的 layout effect 里完成,用户看到的第一帧已经按实测值算过。
 *
 * 真实 Chromium 扫描(11 目录、180px 侧栏、480/700/800/1000 四种窗高、覆盖
 * 全部滚动位置):修复前 33–77% 的位置被裁(最差 300px),修复后四种窗高均为
 * 0%,每个目录的打开按钮都能滚进视野并命中。
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
/** 卡片贴边时至少留出的空隙,不顶到滚动容器的边上。 */
const EDGE_INSET = 8;

export interface CardFit {
	/** 翻到块上方(`--above`)。 */
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
 * 贴下沿;否则翻到更宽裕的一侧;最后把列表夹进那一侧的可用空间(扣掉卡片
 * 固定部分)——装不下就滚动,而不是让卡片溢出被裁。
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
	// 首选:下方装得下就贴下沿。否则翻到更宽裕的一侧——装得下就整张放进去,
	// 都装不下就选装得更多的那侧,由 listMax 把列表夹进剩余空间(滚动可达)。
	//
	// 注意这里 listMax 恒等于 min(room − chrome, natural),所以
	// 「chrome + listMax ≤ room」在夹取分支里**对任何 chrome 都成立**。也就是说
	// 扫描只能证明决策形状自洽,证明不了常量是对的——常量靠挂载实测来纠偏。
	const flip = natural > below && above > below;
	const room = flip ? above : below;
	return { above: flip, listMax: clamp(room - chromeHeight, 0, naturalList) };
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
	/** 项目块下方 / 上方各自还有多少可用高度。调用方按「视口与滚动容器取更近
	 *  的那条边、再减去块自身」算好;这里只做几何适配。 */
	spaceBelow?: number;
	spaceAbove?: number;
}

export function ProjectHoverCard({
	name,
	directories,
	sessionCount,
	labelOf,
	onOpenDirectory,
	openLabel,
	spaceBelow,
	spaceAbove,
}: ProjectHoverCardProps): ReactNode {
	const cardRef = useRef<HTMLDivElement | null>(null);
	// 挂载实测出来的真实几何。首帧用常量估值,`useLayoutEffect` 在绘制前跑完,
	// 所以用户看到的第一次定位就已经按实测算过;常量只是"还没量到"时的过渡值。
	const [metrics, setMetrics] = useState<CardMetrics | null>(null);
	const fit = fitProjectCard({
		directoryCount: directories.length,
		spaceBelow,
		spaceAbove,
		...(metrics ? { chromeHeight: metrics.chrome, rowHeight: metrics.row } : {}),
	});

	useLayoutEffect(() => {
		const next = measureCard(cardRef.current);
		if (!next) return;
		// 只在读数真的变了才重渲染,避免每次父组件重渲染都触发一轮 setState。
		setMetrics(prev =>
			prev && Math.abs(prev.chrome - next.chrome) < 0.5 && Math.abs(prev.row - next.row) < 0.5 ? prev : next,
		);
	});

	const style = { "--gui-project-list-max": `${Math.max(0, fit.listMax)}px` } as CSSProperties;
	return (
		<div
			ref={cardRef}
			className={`gui-project-hover-card${fit.above ? " gui-project-hover-card--above" : ""}`}
			style={style}
			role="group"
			aria-label={name}
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
}
