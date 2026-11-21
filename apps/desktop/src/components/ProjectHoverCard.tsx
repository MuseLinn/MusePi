import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Icon } from "../vendor/oc-icons";

/** 卡片下方的可用空间不足这么多时改向上翻（一行目录约 22px + 卡头）。 */
const CARD_ROOM_BELOW = 150;

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
 * - **不 portal**:会话卡必须 portal 是因为侧栏链路的 backdrop-filter 会劫持
 *   fixed 定位;本卡 `position: absolute` 贴着块的下沿,留在侧栏卡片内部,
 *   天然满足"只在卡片表面内出现",也保住了 Tab 顺序。
 */

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
	/** 项目块下方 / 上方各自还有多少可用高度 —— 只用来决定卡片贴着块
	 *  的下沿还是翻到上沿。调用方按「视口与滚动容器取更近的那条边」算好。 */
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
	// 卡片贴块的下沿；下方空间不够时整卡翻到块上方，否则列表容器会把卡片
	// 从下沿裁掉。
	const above = useMemo(() => {
		if (spaceBelow === undefined || spaceBelow >= CARD_ROOM_BELOW) return false;
		return (spaceAbove ?? 0) > spaceBelow;
	}, [spaceBelow, spaceAbove]);
	return (
		<div
			className={`gui-project-hover-card${above ? " gui-project-hover-card--above" : ""}`}
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
