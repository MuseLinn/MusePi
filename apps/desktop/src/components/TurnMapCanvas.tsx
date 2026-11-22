import { t, tLoose } from "@musepi/client-core";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { timeFormatOptions } from "../lib/appearance";
import { type TurnEventRow, turnEventRows, turnFacts, turnJumpEntryId, turnPreview } from "../lib/turn-map-facts";
import { Icon, type IconName } from "../vendor/oc-icons";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { durationText, TimelineOverview, type TimelineRange } from "./TimelineOverview";
import { type RoundDurationMap, type TrajectoryEvent, trajectoryTurnKey } from "./trajectory-data";
import { createTrajectoryDeriveCache, deriveTrajectoryTree } from "./trajectory-derive";
import {
	arrowTriangle,
	edgePathD,
	layoutTurnMap,
	TURN_LANE_GAP,
	TURN_NODE_H,
	TURN_NODE_W,
	type TurnMapDirection,
	type TurnMapNode,
	turnDisplayLabel,
	visibleTurnMapNodes,
} from "./turn-map-layout";

/**
 * 轮级会话地图:投影单位 = 轮(与折叠/导航/轨迹同一 isTurnStart 口径)。
 *
 * 信息模型(第一性,见 docs/gui-design.md § 会话地图信息模型):
 *  - **卡片 = 索引行**,不是正文预览:固定 66px,一行预览(省略号)+ 轮号、
 *    用时、回复/工具计数、在/离路径。正文留在对话里,「查看对话」跳过去看。
 *  - **检视器 = 明细**:选中轮的头部(时间范围/计数)压在逐事件行
 *    (kind · 标签 · 耗时)之上。检视器只放卡片没有的东西,不重复卡片。
 *  - **边 = 父子方向**:正交折线 + 箭头,父轮出发、子轮收尾;分叉落在干线
 *    交汇圆点上,兄弟各占一条车道,所以分裂看得见、不打架。
 *  - **当前轮不可错认**:描边 + 呼吸;离路径的轮与边整体后退(淡显,仍在),
 *    永远不读成「另一条活的主线」。
 *
 * 交互:单击选中(检视器)/ 双击或 Enter 跳回对话该轮 / 方向键在轮之间移动 /
 * 悬停露出该轮的操作。底部迷你导航条 = 全轮次剪影(两个方向共用)。
 *
 * 性能:节点数 = 轮数(≤ 数百),布局 O(n);视口裁剪只挂视口内的卡。
 */

const FIT_PADDING = 28;
/** 大树自适应缩放下限:超出交给平移,不把卡片缩成细条(设计稿验收 2)。 */
const MIN_FIT_SCALE = 0.75;
const MIN_SCALE = 0.08;
const MAX_SCALE = 2.2;

/** 方向持久化键(读不到/非法值默认纵向)。 */
const MAP_DIRECTION_KEY = "musepi.map.direction";

/** 底部轮次条的左右留边(与 .tm-nav 的 left/right 一致,右侧让位缩放控件)。 */
const TURN_NAV_INSET_LEFT = 16;
const TURN_NAV_INSET_RIGHT = 56;

/**
 * 空白拖拽 → 点击的门控。
 *
 * 指针在空白处平移后松手,浏览器仍会在落点合成一次 click(落点常在空白,
 * 也可能落在卡片/控件上)。那次 click 必须被吞,否则会误选中卡片或触发
 * 控件;但抑制不能无限期存在——合成 click 紧跟 pointerup,超过
 * DRAG_CLICK_WINDOW_MS 的点击一定是用户新操作。只有时间窗能同时满足
 * 两种情况:拖拽后点卡片要正常响应,而拖拽刚松手的那次 click 要被吞。
 */
export const DRAG_CLICK_WINDOW_MS = 400;

export interface DragClickGate {
	/** 新手势开始(pointerdown):上一手势遗留的抑制立即失效。 */
	begin(): void;
	/** 拖拽结束(pointerup):moved = 本次是否平移过,移过则吞掉随后的 click。 */
	end(moved: boolean): void;
	/** 询问并消费抑制:true = 该 click 由拖拽合成,调用方应拦下。 */
	consume(): boolean;
}

export function createDragClickGate(now: () => number = Date.now): DragClickGate {
	let until = Number.NEGATIVE_INFINITY;
	return {
		begin(): void {
			until = Number.NEGATIVE_INFINITY;
		},
		end(moved: boolean): void {
			until = moved ? now() + DRAG_CLICK_WINDOW_MS : Number.NEGATIVE_INFINITY;
		},
		consume(): boolean {
			const active = now() <= until;
			until = Number.NEGATIVE_INFINITY;
			return active;
		},
	};
}

function readMapDirection(): TurnMapDirection {
	try {
		return localStorage.getItem(MAP_DIRECTION_KEY) === "h" ? "h" : "v";
	} catch {
		return "v";
	}
}

/** 轮跳转锚:轮内首个带 entryId 的事件(跳对话用)。 */
function jumpEventOf(group: TurnMapNode["group"]): TrajectoryEvent | undefined {
	return group.events.find(e => e.entryId !== undefined);
}

/** 「切换到此分支」锚:轮末带 entryId 的事件。session.branchAt 对 user
 *  消息定位到其父级(重答语义,还会回填草稿)——切换若以轮首 user 事件
 *  为锚,leaf 落在该轮之前、转录停在"准备重答"态(实机回归 2026-10-02:
 *  地图上怎么切换都显示旧分支 + 输入框出现草稿)。锚到轮末的
 *  assistant/工具节点 = leaf 落在该分支末尾,转录显示"已切到该分支"。
 *  导出供契约测试断言锚选择。 */
export function turnEndEventOf(group: TurnMapNode["group"]): TrajectoryEvent | undefined {
	for (let i = group.events.length - 1; i >= 0; i--) {
		const ev = group.events[i];
		if (ev?.entryId !== undefined) return ev;
	}
	return undefined;
}

/** 「在此分支重新回答」锚:轮首 user 事件(branchAt 的 user→parent 重答
 *  语义正需要 user 消息;无 user 事件的轮回退轮末事件)。导出供契约测试。 */
export function turnUserEventOf(group: TurnMapNode["group"]): TrajectoryEvent | undefined {
	return group.events.find(e => e.kind === "user" && e.entryId !== undefined) ?? turnEndEventOf(group);
}

/** 事件行 kind 图标(与轨迹检视器同色系,oc-icons)。 */
const EVENT_KIND_ICON: Record<TrajectoryEvent["kind"], IconName> = {
	user: "user",
	assistant: "ai-agent",
	tool: "hammer",
	advisor: "sparkling",
	system: "terminal",
};

/** 事件行 kind 标签(检视器行的分类标识,与图标同色系)。 */
const EVENT_KIND_LABEL = {
	user: "transcript.turnMapKindUser",
	assistant: "transcript.turnMapKindAssistant",
	tool: "transcript.turnMapKindTool",
	advisor: "transcript.turnMapKindAdvisor",
	system: "transcript.turnMapKindSystem",
} as const satisfies Record<TrajectoryEvent["kind"], string>;

/** token 数缩写(1.2k 形态;TUI /trace 信息密度,GUI 排版)。 */
function compactTokens(n: number): string {
	if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

/** 时钟(HH:MM:SS),检视器时间范围与行时刻共用。 */
function clockText(ms: number | undefined): string {
	if (ms === undefined) return "—";
	return new Date(ms).toLocaleTimeString(undefined, timeFormatOptions());
}

/**
 * 轮卡(索引行,memo):固定高度,三行——轮号/状态、一行预览、计数。
 *
 * 卡片刻意不含正文:`tm-card-preview` 是单行省略的索引文本,点开看正文是
 * 检视器与对话的事。悬停浮出该轮的操作(查看对话/切换/重答/分叉)。
 *
 * 导出仅供测试断言渲染契约。
 */
export const TmNodeCard = memo(function TmNodeCard({
	n,
	isLeaf,
	isCurrent,
	isSelected,
	searchDim,
	searchHit,
	onSelect,
	onJump,
	onSwitch,
	onReanswer,
	onFork,
	onMenu,
}: {
	n: TurnMapNode;
	isLeaf: boolean;
	isCurrent: boolean;
	isSelected: boolean;
	searchDim: boolean;
	searchHit: boolean;
	/** 单击:选中该轮(检视器显示它)。 */
	onSelect(node: TurnMapNode): void;
	/** 双击 / Enter:跳回对话该轮。 */
	onJump(node: TurnMapNode): void;
	onSwitch(node: TurnMapNode): void;
	onReanswer(node: TurnMapNode): void;
	onFork(node: TurnMapNode): void;
	onMenu(node: TurnMapNode, x: number, y: number): void;
}): ReactNode {
	const preview = useMemo(() => turnPreview(n.group), [n.group]);
	const facts = useMemo(() => turnFacts(n.group), [n.group]);
	const shownTurn = turnDisplayLabel(n.group);
	const jumpable = jumpEventOf(n.group)?.entryId !== undefined;
	return (
		<div
			className={`tm-node${n.branch ? " tm-node--branch" : ""}${isLeaf ? " tm-node--leaf" : ""}${isCurrent ? " tm-node--current" : ""}${n.offPath ? " tm-node--off" : ""}${isSelected ? " tm-node--selected" : ""}${searchDim ? " tm-node--dim" : ""}${searchHit ? " tm-node--hit" : ""}`}
			style={{ left: n.x, top: n.y, width: TURN_NODE_W, height: n.h }}
			role="button"
			tabIndex={0}
			aria-pressed={isSelected}
			aria-label={tLoose("transcript.turnMapCardLabel", { turn: String(shownTurn) })}
			data-turn={n.group.turn}
			onClick={() => onSelect(n)}
			onKeyDown={e => {
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter") {
					e.preventDefault();
					// Enter = 跳转(任务契约):选中是单击/方向键的事,Enter 是"去那里"。
					if (jumpable) onJump(n);
					else onSelect(n);
				} else if (e.key === " ") {
					e.preventDefault();
					onSelect(n);
				}
			}}
			onDoubleClick={() => onJump(n)}
			onContextMenu={e => {
				e.preventDefault();
				e.stopPropagation();
				onMenu(n, e.clientX, e.clientY);
			}}
		>
			<div className="tm-card-head">
				<span className={`tm-turn-badge${n.advisor ? " tm-turn-badge--advisor" : ""}`}>
					{n.group.turn === 0
						? t("settings.trajectorySystemEvents")
						: t("transcript.turnMapTurnLabel", { turn: shownTurn })}
					{n.advisor && (
						<em className="tm-turn-advisor">
							<Icon name="sparkling" className="h-2.5 w-2.5" />
							{t("general.advisor")}
						</em>
					)}
				</span>
				{n.offPath && <span className="tm-card-off">{t("transcript.turnMapOffPath")}</span>}
				{facts.durationMs !== undefined && <span className="tm-node-dur">{durationText(facts.durationMs)}</span>}
			</div>
			<div className="tm-card-preview" title={preview}>
				{preview || tLoose("transcript.turnMapCompactCount", { count: facts.events })}
			</div>
			<div className="tm-card-facts">
				<span className="tm-card-stat">{tLoose("transcript.turnMapReplies", { count: facts.replies })}</span>
				<span className="tm-card-dot" aria-hidden>
					·
				</span>
				<span className="tm-card-stat">{tLoose("transcript.turnMapTools", { count: facts.tools })}</span>
			</div>
			{/* 悬停/键盘焦点浮出该轮操作:查看对话(主操作)+ 切换/重答/分叉。
			    与行内操作同一契约——hover 与 :focus-visible 同时露出。 */}
			<div className="tm-card-actions" onPointerDown={e => e.stopPropagation()}>
				{jumpable && (
					<button
						type="button"
						className="tm-card-act"
						title={t("transcript.turnMapViewConversation")}
						aria-label={t("transcript.turnMapViewConversation")}
						onClick={e => {
							e.stopPropagation();
							onJump(n);
						}}
					>
						<Icon name="arrow-right-s" className="h-3 w-3" />
					</button>
				)}
				<button
					type="button"
					className="tm-card-act"
					title={t("transcript.mapSwitchBranch")}
					aria-label={t("transcript.mapSwitchBranch")}
					onClick={e => {
						e.stopPropagation();
						onSwitch(n);
					}}
				>
					<Icon name="git-merge" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-card-act"
					title={t("transcript.branchReAnswerHere")}
					aria-label={t("transcript.branchReAnswerHere")}
					onClick={e => {
						e.stopPropagation();
						onReanswer(n);
					}}
				>
					<Icon name="git-branch" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-card-act"
					title={t("transcript.forkSessionHere")}
					aria-label={t("transcript.forkSessionHere")}
					onClick={e => {
						e.stopPropagation();
						onFork(n);
					}}
				>
					<Icon name="git-fork" className="h-3 w-3" />
				</button>
			</div>
		</div>
	);
});

/**
 * 轮检视器:选中轮的头部(时间范围/计数)+ 逐事件行(kind · 标签 · 耗时)。
 *
 * 与卡片的分工:卡片给「这是什么轮」,检视器给「这一轮里发生了什么」。正文
 * 不在这里——「查看对话」把用户送回对话看正文,所以检视器不会变成第二个
 * 正文预览。事件行可点:跳到该条消息。
 *
 * 导出仅供测试断言结构契约。
 */
export const TmInspector = memo(function TmInspector({
	node,
	onClose,
	onJump,
	onJumpEvent,
}: {
	node: TurnMapNode;
	onClose(): void;
	onJump(node: TurnMapNode): void;
	onJumpEvent(ev: TrajectoryEvent): void;
}): ReactNode {
	const facts = useMemo(() => turnFacts(node.group), [node.group]);
	const rows = useMemo(() => turnEventRows(node.group), [node.group]);
	const shownTurn = turnDisplayLabel(node.group);
	const jumpId = turnJumpEntryId(node.group);
	return (
		<div className="tm-inspector" role="region" aria-label={t("transcript.turnMapInspectorLabel")}>
			<div className="tm-inspector-head">
				<span className={`tm-turn-badge${node.advisor ? " tm-turn-badge--advisor" : ""}`}>
					{node.group.turn === 0
						? t("settings.trajectorySystemEvents")
						: t("transcript.turnMapTurnLabel", { turn: shownTurn })}
				</span>
				{node.offPath && <span className="tm-card-off">{t("transcript.turnMapOffPath")}</span>}
				<span className="tm-inspector-range">
					{clockText(node.group.startMs)} → {clockText(node.group.endMs)}
				</span>
				{jumpId && (
					<button
						type="button"
						className="tm-inspector-jump"
						title={t("transcript.turnMapViewConversation")}
						aria-label={t("transcript.turnMapViewConversation")}
						onClick={() => onJump(node)}
					>
						<Icon name="arrow-right-s" className="h-3 w-3" />
						<span>{t("transcript.turnMapViewConversation")}</span>
					</button>
				)}
				<button
					type="button"
					className="tm-inspector-close"
					title={t("settings.trajectoryClose")}
					aria-label={t("settings.trajectoryClose")}
					onClick={onClose}
				>
					<Icon name="close" className="h-3 w-3" />
				</button>
			</div>
			<div className="tm-inspector-facts">
				<span className="tm-card-stat">{tLoose("transcript.turnMapReplies", { count: facts.replies })}</span>
				<span className="tm-card-dot" aria-hidden>
					·
				</span>
				<span className="tm-card-stat">{tLoose("transcript.turnMapTools", { count: facts.tools })}</span>
				{facts.durationMs !== undefined && (
					<>
						<span className="tm-card-dot" aria-hidden>
							·
						</span>
						<span className="tm-card-stat">{durationText(facts.durationMs)}</span>
					</>
				)}
			</div>
			{/* 事件行:kind · 标签 · 耗时。正文不进来(见模块头)。 */}
			<div className="tm-inspector-rows">
				{rows.map(row => (
					<TmEventLine key={row.id} row={row} onJump={onJumpEvent} />
				))}
			</div>
		</div>
	);
});

function TmEventLine({ row, onJump }: { row: TurnEventRow; onJump(ev: TrajectoryEvent): void }): ReactNode {
	const link = row.entryId !== undefined;
	return (
		<div
			className={`tm-inspector-row tm-inspector-row--${row.kind}${link ? " tm-inspector-row--link" : ""}`}
			role={link ? "button" : undefined}
			tabIndex={link ? 0 : undefined}
			onClick={e => {
				e.stopPropagation();
				if (link) onJump({ entryId: row.entryId, kind: row.kind } as TrajectoryEvent);
			}}
			onKeyDown={e => {
				if (!link || e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
				e.preventDefault();
				onJump({ entryId: row.entryId, kind: row.kind } as TrajectoryEvent);
			}}
		>
			<Icon name={EVENT_KIND_ICON[row.kind]} className="tm-inspector-icon" />
			<span className={`tm-kind tm-kind--${row.kind}`}>{t(EVENT_KIND_LABEL[row.kind])}</span>
			<span className="tm-inspector-label" title={row.label}>
				{row.label}
			</span>
			<span className="tm-inspector-meta">
				{row.elapsedMs !== undefined && <span className="tm-lane-meta">{durationText(row.elapsedMs)}</span>}
				{row.tsMs !== undefined && <span className="tm-lane-time">{clockText(row.tsMs)}</span>}
			</span>
		</div>
	);
}

export function TurnMapCanvas({
	entries,
	roundDurations,
	leafId,
	pathIds,
	loading,
	hasMore,
	loadingOlder,
	historyBlocked,
	onLoadOlder,
	onJumpToEntry,
	onSwitchToBranch,
	onBranchTo,
	onForkAt,
	composerInset = 0,
}: {
	entries: readonly unknown[];
	/** daemon agent_end 冻结的整轮用时(Map 或持久化 [ms,ms][] 形态)。 */
	roundDurations?: RoundDurationMap;
	/** 当前叶子(view key id;null = 尾部跟随)。 */
	leafId?: string | null;
	/** 对话在视条目 id 集(见 lib/turn-map-path):转录显示什么,这里就认什么
	 *  为主线。未提供 = 无路径信息,不判离路径。 */
	pathIds?: ReadonlySet<string> | null;
	/** 初始窗口加载中。 */
	loading?: boolean;
	/** 当前窗口之前还有可请求的历史页。 */
	hasMore?: boolean;
	/** 按需历史页正在加载。 */
	loadingOlder?: boolean;
	/** 更早历史已不可达，给用户可见的终止状态。 */
	historyBlocked?: boolean;
	/** 显式请求下一页更早历史,不在打开地图时自动拉全量。 */
	onLoadOlder?: () => void;
	/** 双击/Enter/右键跳转:跳回对话并定位该轮(父层切回 chat + requestJump)。 */
	onJumpToEntry?: (entryId: string) => void;
	/** 切换到此分支:移动会话叶子到该分支末尾(session.branchAt,显式
	 *  树操作;锚由内部解析到轮末事件,避免 user→parent 重答语义)。 */
	onSwitchToBranch?: (entryId: string) => void;
	/** 重答该轮(锚 = 轮首 user 事件 entryId)。 */
	onBranchTo?: (entryId: string) => void;
	/** 从该轮分叉新会话。 */
	onForkAt?: (entryId: string) => void;
	/** Bottom occlusion from the floating composer, in CSS pixels. */
	composerInset?: number;
}): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
	const dragRef = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null);
	// 拖拽合成 click 的抑制门(手势内有效,见 createDragClickGate)。
	const clickGate = useRef(createDragClickGate());
	const [dragging, setDragging] = useState(false);
	// 选中轮(检视器的输入);与展开状态分开——选中是"看哪一轮",不再是"展开哪张卡"。
	const [selected, setSelected] = useState<string | null>(null);
	// 右键菜单(node = 轮卡)。
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; node: TurnMapNode | null } | null>(null);
	// 搜索命中轮高亮。
	const [searchQuery, setSearchQuery] = useState("");
	// 方向(v = 主线垂直默认;h = 主线水平),localStorage 持久化。
	const [direction, setDirection] = useState<TurnMapDirection>(readMapDirection);
	const horizontal = direction === "h";

	// P1-11:entries/roundDurations/pathIds 每帧换引用(snapshot 每帧
	// spread),deriveTrajectoryTree 内部按对象身份断点续派生——流式帧只
	// 重跑增量片段,零变更帧返回上次结果引用(契约测试 probe 钉死)。
	const deriveCacheRef = useRef(createTrajectoryDeriveCache());
	const { turns, stats } = useMemo(
		() => deriveTrajectoryTree(entries, roundDurations, pathIds ?? undefined, deriveCacheRef.current),
		[entries, roundDurations, pathIds],
	);
	const layout = useMemo(
		() => layoutTurnMap(turns, { direction, pathIds: pathIds ?? undefined }),
		[turns, direction, pathIds],
	);
	const { nodes, edges, main, splits, width, height } = layout;

	// 叶子优先服从会话 leafId;缺少路径信息时不能拿 journal 尾轮代替活跃叶。
	const leafTurn = useMemo(() => {
		if (leafId != null) {
			const leaf = nodes.find(n => n.group.events.some(e => e.entryId === leafId));
			if (leaf) return leaf.group.turn;
		}
		return main[main.length - 1]?.group.turn ?? null;
	}, [leafId, nodes, main]);
	// 当前轮:活动路径上最靠后的主线轮;无路径信息时跟随真实叶子。
	const currentTurn = useMemo(() => {
		if (pathIds) {
			for (let i = main.length - 1; i >= 0; i--) {
				if (main[i]!.group.events.some(e => e.entryId !== undefined && pathIds.has(e.entryId))) {
					return main[i]!.group.turn;
				}
			}
		}
		return leafTurn;
	}, [main, pathIds, leafTurn]);

	// 搜索:命中轮摘要高亮、其余淡显。
	const searchMatchTurns = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return null;
		const set = new Set<number>();
		for (const n of nodes) {
			if (turnPreview(n.group).toLowerCase().includes(q)) set.add(n.group.turn);
		}
		return set;
	}, [searchQuery, nodes]);

	// ── 视口:fit-all(全部可见)或大树智能适配(可读缩放 + 当前轮居中) ──
	// The composer floats over the bottom of the map. All fit, focus and
	// visibility math uses the remaining rectangle rather than that covered area.
	const needsFitRef = useRef(true);
	const fitView = useCallback((): void => {
		const wrap = wrapRef.current;
		if (!wrap || width === 0 || height === 0) return;
		const cw = wrap.clientWidth;
		const ch = Math.max(0, wrap.clientHeight - composerInset);
		if (cw < 80 || ch < 80) return;
		needsFitRef.current = false;
		const fullScale = Math.min((cw - FIT_PADDING * 2) / width, (ch - FIT_PADDING * 2) / height, 1);
		if (fullScale >= 0.55) {
			const scaledW = width * fullScale;
			const scaledH = height * fullScale;
			setView({
				scale: fullScale,
				x: (cw - scaledW) / 2,
				y: (ch - scaledH) / 2,
			});
			return;
		}
		// 大树:主轴超出 → 可读缩放,当前轮居中("我在哪"优先于看全图)。
		// v = 纵向超出按宽适配;h = 横向超出按高适配。
		const focus = nodes.find(n => n.group.turn === currentTurn) ?? main[main.length - 1] ?? null;
		const fx = (focus?.x ?? 0) + TURN_NODE_W / 2;
		const fy = (focus?.y ?? 0) + TURN_NODE_H / 2;
		const axisFit = horizontal ? (ch - FIT_PADDING * 2) / height : (cw - FIT_PADDING * 2) / width;
		const scale = Math.min(1, Math.max(MIN_FIT_SCALE, axisFit));
		setView({ scale, x: cw / 2 - fx * scale, y: ch / 2 - fy * scale });
	}, [width, height, nodes, currentTurn, main, horizontal, composerInset]);
	// 容器尺寸(state 化):视口裁剪与 fit 几何都依赖它,放 state 里保证
	// 变化触发重算(RO 回调里同步 set,首帧 0 → mount 后即刻修正)。
	const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		const ro = new ResizeObserver(() => {
			setWrapSize({ w: wrap.clientWidth, h: wrap.clientHeight });
			if (needsFitRef.current) fitView();
		});
		ro.observe(wrap);
		if (needsFitRef.current) fitView();
		return () => ro.disconnect();
	}, [fitView]);

	// 视口裁剪:只渲染可见世界矩形内的节点卡(画布版「渐进挂载」)。
	const visibleNodes = useMemo(() => {
		const { w, h } = wrapSize;
		if (w === 0 || h === 0) return nodes;
		const vp = {
			left: -view.x / view.scale,
			top: -view.y / view.scale,
			right: (w - view.x) / view.scale,
			bottom: (Math.max(0, h - composerInset) - view.y) / view.scale,
		};
		return visibleTurnMapNodes(nodes, vp);
	}, [nodes, view, wrapSize, composerInset]);
	const visibleTurns = useMemo(() => new Set(visibleNodes.map(n => n.group.turn)), [visibleNodes]);
	// 边与分叉只画两端都在视口附近的那几条(同一次裁剪的另一半)。
	const visibleEdges = useMemo(
		() => edges.filter(e => visibleTurns.has(e.from.group.turn) || visibleTurns.has(e.to.group.turn)),
		[edges, visibleTurns],
	);
	// 历史补全和流式新轮保留用户视口;只有显式重置或方向切换才重新 fit。
	const fittedDirectionRef = useRef(direction);
	useEffect(() => {
		if (fittedDirectionRef.current === direction) return;
		fittedDirectionRef.current = direction;
		needsFitRef.current = true;
		fitView();
	}, [direction, fitView]);

	const centerOnTurn = useCallback(
		(turn: number, targetScale?: number): void => {
			const wrap = wrapRef.current;
			const n = nodes.find(m => m.group.turn === turn);
			if (!wrap || !n) return;
			const availableHeight = Math.max(0, wrap.clientHeight - composerInset);
			// v:以卡宽+车道距估可读缩放;h:以卡高+行距估。
			const readable = horizontal
				? availableHeight / (TURN_NODE_H + TURN_LANE_GAP * 2)
				: wrap.clientWidth / (TURN_NODE_W + TURN_LANE_GAP * 2);
			const scale = targetScale ?? Math.max(0.7, Math.min(1.2, readable));
			setView({
				scale,
				x: wrap.clientWidth / 2 - (n.x + TURN_NODE_W / 2) * scale,
				y: availableHeight / 2 - (n.y + n.h / 2) * scale,
			});
		},
		[nodes, horizontal, composerInset],
	);

	// 滚轮缩放(原生 non-passive,preventDefault 阻止背后页面滚动)。
	const onWheel = useCallback((e: WheelEvent) => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		for (let el = e.target as HTMLElement | null; el && el !== wrap; el = el.parentElement) {
			const overflowY = getComputedStyle(el).overflowY;
			if (/(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) return;
		}
		e.preventDefault();
		const rect = wrap.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		setView(v => {
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
			const k = scale / v.scale;
			return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
		});
	}, []);
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => wrap.removeEventListener("wheel", onWheel);
	}, [onWheel]);

	// 空白拖拽平移(节点卡/控件上不启动)。
	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (e.button !== 0) return;
			// 任何新手势都作废上一手势遗留的抑制:拖拽在空白处松手后,
			// 下一次点卡片必须正常响应。
			clickGate.current.begin();
			const target = e.target as HTMLElement;
			if (target.closest(".tm-node, .tm-inspector, .tm-topbar, .tm-nav, .tm-zoom, .tm-search, .gui-context-menu"))
				return;
			// 空白点按:清选中(检视器收起),然后准备拖拽判定。
			setSelected(null);
			dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false };
			setDragging(true);
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		},
		[view.x, view.y],
	);
	const onPointerMove = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
		setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
	}, []);
	const onPointerUp = useCallback(() => {
		// 平移过的空白拖拽:浏览器随后合成的 click 落在空白或卡片上都要吞。
		clickGate.current.end(dragRef.current?.moved ?? false);
		dragRef.current = null;
		setDragging(false);
	}, []);

	/** 单击 = 选中(检视器显示该轮);双击 = 跳对话。 */
	const selectNode = useCallback((node: TurnMapNode) => {
		setSelected(trajectoryTurnKey(node.group));
	}, []);
	const jumpNode = useCallback(
		(node: TurnMapNode) => {
			const ev = jumpEventOf(node.group);
			if (ev?.entryId && onJumpToEntry) onJumpToEntry(ev.entryId);
		},
		[onJumpToEntry],
	);
	const jumpToEvent = useCallback(
		(ev: TrajectoryEvent) => {
			if (ev.entryId && onJumpToEntry) onJumpToEntry(ev.entryId);
		},
		[onJumpToEntry],
	);
	// 切换到此分支:锚 = 轮末事件(branchAt 的 user→parent 是重答语义)。
	const switchNode = useCallback(
		(node: TurnMapNode) => {
			const anchor = turnEndEventOf(node.group) ?? jumpEventOf(node.group);
			if (anchor?.entryId && onSwitchToBranch) onSwitchToBranch(anchor.entryId);
		},
		[onSwitchToBranch],
	);
	// 重答:锚 = 轮首 user 事件(重答契约:branchAt 定位父级 + 回填草稿)。
	const reanswerNode = useCallback(
		(node: TurnMapNode) => {
			const ev = turnUserEventOf(node.group);
			if (ev?.entryId && onBranchTo) onBranchTo(ev.entryId);
		},
		[onBranchTo],
	);
	const forkNode = useCallback(
		(node: TurnMapNode) => {
			const ev = jumpEventOf(node.group);
			if (ev?.entryId && onForkAt) onForkAt(ev.entryId);
		},
		[onForkAt],
	);
	// 节点右键菜单(stable,供 memo 卡引用)。
	const openNodeMenu = useCallback((node: TurnMapNode, x: number, y: number) => {
		setCtxMenu({ x, y, node });
	}, []);

	// 顶栏批量折叠/展开 + 方向切换。折叠/展开在这里的含义是"全部选中/清空"
	// 已经不再适用——卡片固定高度,没有可折叠的内容;按钮改为全选中的
	// 上一轮/下一轮导航会与方向键重复,所以这里保留"适配视图"与方向。
	const switchDirection = useCallback(() => {
		setDirection(d => {
			const next = d === "v" ? "h" : "v";
			try {
				localStorage.setItem(MAP_DIRECTION_KEY, next);
			} catch {
				// localStorage 不可用(隐私模式)——仅会话内生效。
			}
			return next;
		});
	}, []);

	// ── 键盘遍历:方向键在轮之间移动(主线 + 车道),选中并保持可见 ──
	// 顺序 = 布局节点序(主线按时间,分支随其父轮之后出现),与视觉阅读顺序
	// 一致;Home/End 跳到首/末轮。
	const selectedNode = useMemo(
		() => (selected === null ? null : (nodes.find(n => trajectoryTurnKey(n.group) === selected) ?? null)),
		[selected, nodes],
	);
	const moveSelection = useCallback(
		(delta: number) => {
			if (nodes.length === 0) return;
			const currentIndex = selected === null ? -1 : nodes.findIndex(n => trajectoryTurnKey(n.group) === selected);
			const from = currentIndex < 0 ? (delta > 0 ? -1 : nodes.length) : currentIndex;
			const next = Math.max(0, Math.min(nodes.length - 1, from + delta));
			const node = nodes[next];
			if (!node) return;
			setSelected(trajectoryTurnKey(node.group));
			centerOnTurn(node.group.turn);
		},
		[nodes, selected, centerOnTurn],
	);
	const jumpSelected = useCallback(() => {
		if (selectedNode) jumpNode(selectedNode);
	}, [selectedNode, jumpNode]);

	// 右键菜单:跳转/切换分支/重答/分叉;空白 = 适配视图。
	const ctxItems = useMemo<ContextMenuItem[]>(() => {
		if (!ctxMenu) return [];
		if (ctxMenu.node !== null) {
			const node = ctxMenu.node;
			const ev = jumpEventOf(node.group);
			const switchEv = turnEndEventOf(node.group) ?? ev;
			const reanswerEv = turnUserEventOf(node.group) ?? ev;
			const items: ContextMenuItem[] = [];
			if (ev?.entryId && onJumpToEntry) {
				items.push({
					label: t("settings.trajectoryJump"),
					description: t("settings.contextJumpDesc"),
					icon: "arrow-go-forward",
					onSelect: () => onJumpToEntry(ev.entryId!),
				});
			}
			if (switchEv?.entryId && onSwitchToBranch) {
				items.push({
					label: t("transcript.mapSwitchBranch"),
					description: t("transcript.mapSwitchBranchDesc"),
					icon: "git-merge",
					onSelect: () => onSwitchToBranch(switchEv.entryId!),
				});
			}
			if (reanswerEv?.entryId && onBranchTo) {
				items.push({
					label: t("transcript.branchReAnswerHere"),
					description: t("settings.contextBranchDesc"),
					icon: "git-branch",
					onSelect: () => onBranchTo(reanswerEv.entryId!),
				});
			}
			if (ev?.entryId && onForkAt) {
				items.push({
					label: t("transcript.forkSessionHere"),
					description: t("settings.contextForkDesc"),
					icon: "git-fork",
					onSelect: () => onForkAt(ev.entryId!),
				});
			}
			return items;
		}
		return [
			{
				label: t("transcript.canvasResetView"),
				description: t("settings.contextResetDesc"),
				icon: "align-justify",
				onSelect: () => {
					needsFitRef.current = true;
					fitView();
				},
			},
		];
	}, [ctxMenu, onJumpToEntry, onSwitchToBranch, onBranchTo, onForkAt, fitView]);

	// 顶部时间轴:拖拽区间聚焦 / 单击整轮定位(轨迹检视器同款交互)。
	const [range, setRange] = useState<TimelineRange | null>(null);
	useEffect(() => {
		if (!range) return;
		for (const n of nodes) {
			if (n.group.events.some(e => e.tsMs !== undefined && e.tsMs >= range.startMs && e.tsMs <= range.endMs)) {
				centerOnTurn(n.group.turn);
				break;
			}
		}
	}, [range, nodes, centerOnTurn]);

	const hasSearch = searchQuery.trim().length > 0;

	// 迷你导航条几何:底部横条按主轴世界跨度等比,视口窗口实时映射。
	const navGeo = useMemo(() => {
		const wrap = wrapRef.current;
		// 横条实际跨度 = 容器宽 - 左右留边(.tm-nav border box);按它取条目
		// 宽度和居中量,点击命中与视口指示才和画出来的条目对齐。
		const railSize = (wrap?.clientWidth ?? 600) - TURN_NAV_INSET_LEFT - TURN_NAV_INSET_RIGHT;
		const band = Math.max(2, Math.min(6, railSize / Math.max(nodes.length, 1)));
		return { railSize, band };
	}, [nodes.length, wrapSize]);
	const viewportBand = useMemo(() => {
		const wrap = wrapRef.current;
		if (!wrap || nodes.length === 0) return null;
		const { railSize, band } = navGeo;
		const total = nodes.length * band;
		const off = Math.max(0, (railSize - total) / 2);
		// 世界主轴坐标 → 导航条位置:导航条目按节点索引等宽排列(flex),
		// 而视口是世界坐标 —— 展开节点 / 分支列会让两者漂移。以每个节点的
		// 主轴坐标为锚做分段线性插值:视口边缘对准某轮坐标时,指示窗也对准
		// 该轮条目(点击定位与指示窗共用同一几何,不再各说各话)。
		const axisOf = horizontal ? (n: TurnMapNode) => n.x : (n: TurnMapNode) => n.y;
		const axisMax = horizontal ? width : height;
		const anchors = nodes.map((n, i) => ({ c: axisOf(n), r: off + (i + 0.5) * band })).sort((a, b) => a.c - b.c);
		const worldToRail = (w: number): number => {
			const clamped = Math.max(0, Math.min(axisMax, w));
			if (clamped <= anchors[0]!.c) return anchors[0]!.r;
			const last = anchors[anchors.length - 1]!;
			if (clamped >= last.c) return last.r;
			let lo = 0;
			let hi = anchors.length - 1;
			while (hi - lo > 1) {
				const mid = (lo + hi) >> 1;
				if (anchors[mid]!.c <= clamped) lo = mid;
				else hi = mid;
			}
			const a0 = anchors[lo]!;
			const a1 = anchors[hi]!;
			const t = a1.c > a0.c ? (clamped - a0.c) / (a1.c - a0.c) : 0;
			return a0.r + t * (a1.r - a0.r);
		};
		// 视口世界区间沿主轴(纵向 = Y,横向 = X)映射到横条的 X 坐标:
		// 指示窗与条目共用同一段线性插值,点击定位不会各说各话。
		const worldStart = horizontal ? -view.x / view.scale : -view.y / view.scale;
		const worldEnd = horizontal
			? (wrap.clientWidth - view.x) / view.scale
			: (Math.max(0, wrap.clientHeight - composerInset) - view.y) / view.scale;
		const start = worldToRail(worldStart);
		const end = worldToRail(worldEnd);
		return { start: Math.max(0, start), size: Math.min(railSize, Math.max(10, end - start)) };
	}, [view, navGeo, width, height, nodes, horizontal, composerInset]);

	return (
		<div
			ref={wrapRef}
			className="tm-wrap"
			// 键盘遍历的焦点目标:浏览器只把键盘事件交给可聚焦元素,所以画布
			// 本身必须可聚焦,方向键/Home/End 才可达。
			tabIndex={0}
			role="application"
			aria-label={t("transcript.turnMapTitle")}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onClickCapture={e => {
				// 拖拽松手后浏览器合成的 click:落点可能是空白、卡片或控件,
				// 在此一次性消费,卡片与控件都不再看到它。键盘激活没有拖拽,
				// consume() 恒为 false。
				if (!clickGate.current.consume()) return;
				e.preventDefault();
				e.stopPropagation();
			}}
			onKeyDown={e => {
				// 键盘遍历只在画布自身持有焦点时接管;卡片内部的按钮不抢。
				if (e.target !== e.currentTarget) return;
				if (e.key === "ArrowDown" || e.key === "ArrowRight") {
					e.preventDefault();
					moveSelection(1);
				} else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
					e.preventDefault();
					moveSelection(-1);
				} else if (e.key === "Home") {
					e.preventDefault();
					moveSelection(-nodes.length);
				} else if (e.key === "End") {
					e.preventDefault();
					moveSelection(nodes.length);
				} else if (e.key === "Enter") {
					e.preventDefault();
					jumpSelected();
				} else if (e.key === "Escape") {
					setSelected(null);
				}
			}}
			onContextMenu={e => {
				e.preventDefault();
				setCtxMenu({ x: e.clientX, y: e.clientY, node: null });
			}}
			data-dragging={dragging || undefined}
		>
			{/* 顶栏:标题 + 轮数 + 搜索 + 时间轴 + 方向(玻璃容器)。 */}
			<div className="tm-topbar" onPointerDown={e => e.stopPropagation()}>
				<span className="tm-title">
					{t("transcript.turnMapTitle")}
					<em className="tm-title-count">{tLoose("transcript.turnMapTurnsCount", { count: stats.turns })}</em>
					{loading === true && <em className="tm-title-loading">{t("transcript.turnMapLoadingHistory")}</em>}
				</span>
				{hasMore && (
					<button
						type="button"
						className="tm-topbar-btn tm-load-older"
						title={loadingOlder ? t("transcript.turnMapLoadingHistory") : t("settings.loadMore")}
						aria-label={loadingOlder ? t("transcript.turnMapLoadingHistory") : t("settings.loadMore")}
						disabled={loadingOlder}
						onClick={() => onLoadOlder?.()}
					>
						<Icon name="arrow-up" className="h-3 w-3" />
					</button>
				)}
				{historyBlocked && <span className="tm-history-blocked">{t("settings.olderHistoryUnavailable")}</span>}
				{turns.length > 0 && <TimelineOverview turns={turns} selection={range} onSelectionChange={setRange} />}
				<div className="tm-search" role="search">
					<Icon name="search" className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
					<input
						className="tm-search-input"
						type="text"
						placeholder={t("settings.trajectorySearchPlaceholder")}
						value={searchQuery}
						onChange={e => setSearchQuery(e.target.value)}
					/>
				</div>
				<button
					type="button"
					className="tm-topbar-btn"
					title={t(horizontal ? "transcript.turnMapLayoutVertical" : "transcript.turnMapLayoutHorizontal")}
					aria-label={t(horizontal ? "transcript.turnMapLayoutVertical" : "transcript.turnMapLayoutHorizontal")}
					onClick={switchDirection}
				>
					<Icon name="layout-column" className="h-3 w-3" />
				</button>
			</div>
			{nodes.length === 0 ? (
				<p className="tm-empty">{t("settings.trajectoryEmpty")}</p>
			) : (
				<>
					{/* 迷你导航条:全轮次剪影 + 视口映射 + 点击跳转。
						两种主线方向都锚在画布底缘横条,不占左侧、不压顶栏。 */}
					<div
						className="tm-nav"
						data-orient={direction}
						style={{ bottom: 10 + composerInset }}
						onPointerDown={e => e.stopPropagation()}
						onClick={e => {
							const rect = e.currentTarget.getBoundingClientRect();
							const { band } = navGeo;
							const along = e.clientX - rect.left;
							const idx = Math.floor((along - Math.max(0, (navGeo.railSize - nodes.length * band) / 2)) / band);
							const clamped = Math.max(0, Math.min(nodes.length - 1, idx));
							const turn = nodes[clamped]?.group.turn;
							if (turn !== undefined) centerOnTurn(turn);
						}}
						title={t("settings.trajectoryTurns")}
					>
						{nodes.map(n => (
							<span
								key={trajectoryTurnKey(n.group)}
								className={`tm-nav-band tm-comp--${n.advisor ? "advisor" : (n.group.events[0]?.kind ?? "user")}${n.offPath ? " tm-nav-band--off" : ""}`}
								style={{ width: navGeo.band }}
							/>
						))}
						{viewportBand && (
							<span className="tm-nav-viewport" style={{ left: viewportBand.start, width: viewportBand.size }} />
						)}
					</div>
					<div
						className="tm-world"
						style={{
							width,
							height,
							transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
						}}
					>
						<svg className="tm-edges" width={width} height={height}>
							{/* 渐变必须真的存在:CSS 用 `stroke: url(#tm-main-line)` 引用它们,
							    删掉 <defs> 后计算样式仍然读作 url(...),但什么也不画——连线与
							    箭头一起消失,而所有路径几何断言依然通过。
							    userSpaceOnUse 是必需的:垂直主线的包围盒宽度为 0,默认
							    objectBoundingBox 单位下渐变退化成不可见描边。 */}
							<defs>
								<linearGradient
									id="tm-main-line"
									gradientUnits="userSpaceOnUse"
									x1="0"
									y1="0"
									x2={horizontal ? width : 0}
									y2={horizontal ? 0 : height}
								>
									<stop offset="0%" className="tm-edge-gold-1" />
									<stop offset="100%" className="tm-edge-gold-2" />
								</linearGradient>
								<linearGradient
									id="tm-branch-line"
									gradientUnits="userSpaceOnUse"
									x1="0"
									y1="0"
									x2={horizontal ? 0 : width}
									y2={horizontal ? height : 0}
								>
									<stop offset="0%" className="tm-edge-gold-1" />
									<stop offset="100%" className="tm-edge-purple" />
								</linearGradient>
							</defs>
							{visibleEdges.map(e => {
								const key = `${trajectoryTurnKey(e.from.group)}>${trajectoryTurnKey(e.to.group)}`;
								const tri = arrowTriangle(e.arrow);
								return (
									<g
										key={key}
										className={`tm-edge-group${e.branch ? " tm-edge-group--branch" : ""}${e.offPath ? " tm-edge-group--off" : ""}`}
										// 端点轮号是布局自己的事实;判定「连线穿卡」时要排除的
										// 正是这两张卡,靠屏幕距离去猜会在 fitView 缩放后认错。
										data-from-turn={e.from.group.turn}
										data-to-turn={e.to.group.turn}
									>
										<path
											className={`tm-edge${e.branch ? " tm-edge--branch" : " tm-edge--main"}`}
											d={edgePathD(e.points)}
										/>
										<polygon
											className={`tm-arrow${e.branch ? " tm-arrow--branch" : ""}`}
											points={tri.map(p => `${p.x},${p.y}`).join(" ")}
										/>
									</g>
								);
							})}
							{/* 干线交汇点:兄弟分支共享的分叉圆点,压在连线上。 */}
							{splits
								.filter(s => visibleTurns.has(s.source.group.turn))
								.map(s => (
									<circle
										key={`split-${s.source.group.turn}`}
										className="tm-junction"
										cx={s.x}
										cy={s.y}
										r={4}
									/>
								))}
						</svg>
						{/* 分叉标签:分裂点上写一次「自 Turn N · k 支」,不在每条
						    车道头重复。 */}
						{splits
							.filter(s => visibleTurns.has(s.source.group.turn) && s.count > 0)
							.map(s => (
								<div
									key={`split-label-${s.source.group.turn}`}
									className="tm-split-label"
									style={{ left: s.x + 10, top: Math.max(0, s.y - 16) }}
								>
									{s.count === 1
										? tLoose("transcript.turnMapSplitOne", { turn: String(s.sourceLabel) })
										: tLoose("transcript.turnMapSplit", { turn: String(s.sourceLabel), count: s.count })}
								</div>
							))}
						{visibleNodes.map(n => (
							<TmNodeCard
								key={trajectoryTurnKey(n.group)}
								n={n}
								isLeaf={leafTurn === n.group.turn}
								isCurrent={currentTurn === n.group.turn}
								isSelected={selected === trajectoryTurnKey(n.group)}
								searchDim={hasSearch && searchMatchTurns !== null && !searchMatchTurns.has(n.group.turn)}
								searchHit={hasSearch && (searchMatchTurns?.has(n.group.turn) ?? false)}
								onSelect={selectNode}
								onJump={jumpNode}
								onSwitch={switchNode}
								onReanswer={reanswerNode}
								onFork={forkNode}
								onMenu={openNodeMenu}
							/>
						))}
					</div>
					{/* 检视器:选中轮的明细。停在地图右上,与顶栏同一条玻璃语言;
					    只在选中时出现,空白点按收起。 */}
					{selectedNode && (
						<div className="tm-inspector-seat" style={{ top: 96, bottom: 56 + composerInset }}>
							<TmInspector
								node={selectedNode}
								onClose={() => setSelected(null)}
								onJump={jumpNode}
								onJumpEvent={jumpToEvent}
							/>
						</div>
					)}
				</>
			)}
			{/* 右下缩放控件。 */}
			<div className="tm-zoom" style={{ bottom: 14 + composerInset }} onPointerDown={e => e.stopPropagation()}>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("settings.locateCurrent")}
					aria-label={t("settings.locateCurrent")}
					disabled={currentTurn === null}
					onClick={() => currentTurn !== null && centerOnTurn(currentTurn)}
				>
					<Icon name="target" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("transcript.canvasZoom")}
					aria-label={t("transcript.canvasZoom")}
					onClick={() =>
						setView(v => {
							const scale = Math.min(MAX_SCALE, v.scale * 1.2);
							const k = scale / v.scale;
							const wrap = wrapRef.current;
							const cx = (wrap?.clientWidth ?? 0) / 2;
							const cy = (wrap?.clientHeight ?? 0) / 2;
							return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
						})
					}
				>
					<Icon name="add" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("transcript.canvasResetView")}
					aria-label={t("transcript.canvasResetView")}
					onClick={() => {
						needsFitRef.current = true;
						fitView();
					}}
				>
					<Icon name="align-justify" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="tm-zoom-btn"
					title={t("transcript.canvasZoomOut")}
					aria-label={t("transcript.canvasZoomOut")}
					onClick={() =>
						setView(v => {
							const scale = Math.max(MIN_SCALE, v.scale / 1.2);
							const k = scale / v.scale;
							const wrap = wrapRef.current;
							const cx = (wrap?.clientWidth ?? 0) / 2;
							const cy = (wrap?.clientHeight ?? 0) / 2;
							return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
						})
					}
				>
					<Icon name="subtract" className="h-3 w-3" />
				</button>
			</div>
			{ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} open onClose={() => setCtxMenu(null)} />}
		</div>
	);
}
