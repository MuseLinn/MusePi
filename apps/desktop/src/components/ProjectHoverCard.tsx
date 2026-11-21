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
 * **高度随目录数增长,适配按几何算**:64 个目录的卡片在 800px 高的窗口里接近
 * 1.4k px,任何固定阈值都装不下,会被滚动容器裁掉——而卡片又在滚动时收起,
 * 裁掉的部分再也够不到。所以先由布局常量推出首选高度决定翻不翻,再把列表的
 * `max-height` 夹到真实可用空间(装不下就让列表自己滚);渲染后再实测一次
 * 兜底,字号被用户放大导致常量偏小时继续收缩列表,绝不让卡片溢出。
 *
 * 真实 Chromium 扫描(11 目录、180px 侧栏、480/700/800/1000 四种窗高、覆盖
 * 全部滚动位置):修复前 33–77% 的位置被裁(最差 300px),修复后四种窗高均为
 * 0%,每个目录的打开按钮都能滚进视野并命中。
 */

/** 卡片除目录列表之外的固定高度,实测于 Chromium:上下 padding 2×10、
 *  标题行 17.55、说明行 28、两处 6px gap = 77.55。说明行按两行算,因为窄
 *  卡片(180px)里「11 个目录 · 4 个会话」会折行——按单行 16px 估会让卡片
 *  溢出约 12px。`project-hover-card.test.tsx` 断言它与浅色/DOM 实测一致。 */
export const CARD_CHROME_HEIGHT = 78;
/** 目录列表自身的高度上限:`min(280px, 50vh)`(见 `gui-chrome.css`)。 */
export const LIST_MAX_HEIGHT = 280;
/** 一行目录的高度:内容行 ≈17 + 上下 padding 2×3 + 行间距 1。 */
export const ROW_HEIGHT = 24;
/** 卡片贴边时至少留出的空隙,不顶到滚动容器的边上。 */
const EDGE_INSET = 8;

export interface CardFit {
	/** 翻到块上方(`--above`)。 */
	above: boolean;
	/** 列表实际可用的高度(像素)—— 永远不超过真实可占空间。 */
	listMax: number;
	/** 未受可用空间限制时的列表高度,用于实测兜底判断。 */
	naturalList: number;
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
}: {
	directoryCount: number;
	spaceBelow?: number;
	spaceAbove?: number;
	listMax?: number;
}): CardFit {
	const naturalList = Math.min(Math.max(directoryCount, 0) * ROW_HEIGHT, listMax);
	const natural = CARD_CHROME_HEIGHT + naturalList;
	// 没有测量信息(测试/首帧)时按首选方向贴下沿。
	if (spaceBelow === undefined && spaceAbove === undefined) {
		return { above: false, listMax: naturalList, naturalList };
	}

	const below = Math.max(0, (spaceBelow ?? 0) - EDGE_INSET);
	const above = Math.max(0, (spaceAbove ?? 0) - EDGE_INSET);
	// 首选:下方装得下就贴下沿。否则翻到更宽裕的一侧——装得下就整张放进去,
	// 都装不下就选装得更多的那侧,由 listMax 把列表夹进剩余空间(滚动可达)。
	const flip = natural > below && above > below;
	const room = flip ? above : below;
	// room 是卡片整体可占的高度:列表只能拿掉固定部分之后剩下的那一段。
	return { above: flip, listMax: clamp(room - CARD_CHROME_HEIGHT, 0, naturalList), naturalList };
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
	// 实测兜底:字号被放大时布局常量会偏小,渲染后按真实高度再收缩列表。
	const [measuredShrink, setMeasuredShrink] = useState(0);
	const fit = fitProjectCard({ directoryCount: directories.length, spaceBelow, spaceAbove });
	const listMax = Math.max(0, fit.listMax - measuredShrink);
	// 调用方没给测量信息时不做兜底,否则「可用空间 0」会把卡片压没。
	const measured = spaceBelow !== undefined || spaceAbove !== undefined;
	const room = Math.max(0, (fit.above ? (spaceAbove ?? 0) : (spaceBelow ?? 0)) - EDGE_INSET);

	useLayoutEffect(() => {
		const card = cardRef.current;
		// 未布局(happy-dom、隐藏中)时高度为 0,不做判断。
		if (!card || !measured) return;
		const height = card.getBoundingClientRect().height;
		if (height <= 0) return;
		// 只收缩、不放大:常量算出的列表已按可用空间夹过,实测只补常量偏小的
		// 那部分(例如用户放大字号)。收缩量恰为溢出量,重排后即收敛。
		const shrink = Math.max(0, height - room);
		setMeasuredShrink(prev => (prev === shrink ? prev : shrink));
	}, [measured, room, fit.above, fit.listMax]);

	const style = { "--gui-project-list-max": `${Math.max(0, listMax)}px` } as CSSProperties;
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
				<span>{t("general.projectDirectoryCount", { count: directories.length })}</span>
				<span className="gui-project-hover-card-dot" aria-hidden="true" />
				<span>{t("settings.sessionCountLabel", { count: sessionCount })}</span>
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
