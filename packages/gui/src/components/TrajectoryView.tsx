import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildMessageTree, type MessageTreeNode, TREE_ICON, treeKindOf, treeTextOf } from "../lib/message-tree";
import { Icon } from "../vendor/oc-icons";
import { FadeScroll } from "./FadeScroll";
import { durationText, TimelineOverview, type TimelineRange } from "./TimelineOverview";
import {
	buildTrajectoryTree,
	isTrajectoryEventInRange,
	type RoundDurationMap,
	type TrajectoryEvent,
} from "./trajectory-data";

/** 令牌数紧凑化(1.2k / 45.6k / 1.8M)——与 transcript usage 行同语感。 */
function fmtTokens(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
}

/** 单条轨迹事件行(折叠树展开后 + 无 onJumpToEntry 时的平铺回退)。
 *  点击行 = 选中进检视器;右上跳转按钮 = 跳转 transcript(事件不冒泡)。 */
function EventRow({
	ev,
	selected,
	dimmed,
	onSelect,
	onJumpToEntry,
	children,
}: {
	ev: TrajectoryEvent;
	selected: boolean;
	dimmed: boolean;
	onSelect(id: string | null): void;
	onJumpToEntry?: (entryId: string) => void;
	children?: ReactNode;
}): ReactNode {
	return (
		<div className="traj-row" onClick={() => onSelect(selected ? null : ev.id)}>
			<div
				className={`traj-event traj-event--${ev.kind}${selected ? " traj-event--selected" : ""}${dimmed ? " traj-event--dim" : ""}`}
			>
				<span className={`traj-tag traj-tag--${ev.kind}`}>
					{ev.kind === "tool" ? (
						<Icon name="hammer" className="h-2.5 w-2.5" />
					) : ev.kind === "system" ? (
						<Icon name="settings-3" className="h-2.5 w-2.5" />
					) : null}
					{ev.kind === "assistant"
						? "ASSISTANT"
						: ev.kind === "tool"
							? "TOOL"
							: ev.kind === "user"
								? "USER"
								: "SYSTEM"}
				</span>
				<div className="traj-content">
					{ev.kind === "tool" ? (
						<>
							<div className="traj-tool-name">{ev.title}</div>
							{ev.body && <pre className="traj-args">{ev.body}</pre>}
							{ev.result && (
								<pre className="traj-result">
									<span className="traj-result-arrow">→ </span>
									{ev.result}
								</pre>
							)}
						</>
					) : ev.kind === "system" ? (
						<div className="traj-text">
							{ev.title === "model_change" ? t("model changed") : t("thinking level changed")}
						</div>
					) : (
						<div className="traj-text">{ev.body ?? ev.title}</div>
					)}
				</div>
			</div>
			{children}
			{/* 跳转入口 = 独立箭头小按钮(不再包裹整行):整行点击 = 选中检视,
			 * 箭头点击 = 跳转 transcript。包裹式按钮此前把整行点击吞成跳转,
			 * 检视器永远点不出来的回归(2026-08-21 实测)。 */}
			{onJumpToEntry && ev.entryId ? (
				<button
					type="button"
					className="traj-event-jump"
					title={t("trajectory jump")}
					aria-label={t("trajectory jump")}
					onClick={e => {
						e.stopPropagation();
						onJumpToEntry(ev.entryId!);
					}}
				>
					<Icon name="arrow-right-s" className="traj-jump-icon" />
				</button>
			) : null}
		</div>
	);
}

/** 检视面板(DSH Trajectory 选择→检视 parity):选中记录的时刻/回合用时 +
 *  Input/Output/Thinking 明细。紧凑卡,复用 gui-ctx-stat 的数值字体。 */
function InspectorCard({
	ev,
	roundDurationMs,
	onClose,
}: {
	ev: TrajectoryEvent;
	roundDurationMs?: number;
	onClose(): void;
}): ReactNode {
	const kindLabel =
		ev.kind === "user"
			? t("trajectory user")
			: ev.kind === "tool"
				? "TOOL"
				: ev.kind === "system"
					? "SYSTEM"
					: "ASSISTANT";
	const timeText =
		ev.tsMs !== undefined
			? new Date(ev.tsMs).toLocaleString()
			: ev.timestamp
				? new Date(ev.timestamp).toLocaleString()
				: "—";
	const input = ev.kind === "user" ? ev.title : ev.kind === "tool" ? ev.body : "";
	const output = ev.kind === "tool" ? ev.result : ev.kind === "assistant" ? ev.body : "";
	// settled 回合的模型请求统计(wire AssistantMessage.usage/duration/ttft)。
	const rateText =
		ev.usage && ev.durationMs !== undefined && ev.durationMs > 100 && ev.usage.output > 0
			? `${((ev.usage.output / ev.durationMs) * 1000).toFixed(1)}/s`
			: undefined;

	return (
		<div className="traj-inspector">
			<div className="traj-inspector-head">
				<span className={`traj-tag traj-tag--${ev.kind}`}>{kindLabel}</span>
				<span className="traj-inspector-title">{ev.title}</span>
				<button
					type="button"
					className="traj-inspector-close"
					title={t("trajectory close")}
					aria-label={t("trajectory close")}
					onClick={onClose}
				>
					<Icon name="close" className="h-3 w-3" />
				</button>
			</div>
			<div className="traj-inspector-body">
				<div className="traj-inspector-grid">
					<div className="gui-ctx-stat">
						<div className="gui-ctx-stat-v text-[11px]">{t("trajectory time")}</div>
						<div className="traj-inspector-value">{timeText}</div>
					</div>
					<div className="gui-ctx-stat">
						<div className="gui-ctx-stat-v text-[11px]">{t("trajectory turns")}</div>
						<div className="traj-inspector-value">Turn {ev.turn}</div>
					</div>
					{roundDurationMs !== undefined && (
						<div className="gui-ctx-stat">
							<div className="gui-ctx-stat-v text-[11px]">{t("trajectory round duration")}</div>
							<div className="traj-inspector-value">{durationText(roundDurationMs)}</div>
						</div>
					)}
					{ev.tsMs !== undefined && (
						<div className="gui-ctx-stat">
							<div className="gui-ctx-stat-v text-[11px]">{t("trajectory clock")}</div>
							<div className="traj-inspector-value">
								{new Date(ev.tsMs).toLocaleTimeString(undefined, { hour12: false })}
							</div>
						</div>
					)}
					{/* settled 回合的模型请求统计(wire AssistantMessage 原样携带)。 */}
					{ev.usage && (
						<div className="gui-ctx-stat">
							<div className="gui-ctx-stat-v text-[11px]">{t("trajectory tokens")}</div>
							<div className="traj-inspector-value">
								{fmtTokens(ev.usage.input + ev.usage.cacheWrite)}↑ {fmtTokens(ev.usage.output)}↓
								{ev.usage.cacheRead > 0 ? ` ☍${fmtTokens(ev.usage.cacheRead)}` : ""}
							</div>
						</div>
					)}
					{ev.usage && ev.ttftMs !== undefined && (
						<div className="gui-ctx-stat">
							<div className="gui-ctx-stat-v text-[11px]">{t("trajectory ttft")}</div>
							<div className="traj-inspector-value">{(ev.ttftMs / 1000).toFixed(1)}s</div>
						</div>
					)}
					{ev.durationMs !== undefined && (
						<div className="gui-ctx-stat">
							<div className="gui-ctx-stat-v text-[11px]">{t("trajectory request duration")}</div>
							<div className="traj-inspector-value">{durationText(ev.durationMs)}</div>
						</div>
					)}
					{rateText !== undefined && (
						<div className="gui-ctx-stat">
							<div className="gui-ctx-stat-v text-[11px]">{t("trajectory rate")}</div>
							<div className="traj-inspector-value">{rateText}</div>
						</div>
					)}
				</div>
				{input !== undefined && input !== "" && (
					<div className="traj-inspector-block">
						<div className="traj-inspector-block-label">{t("trajectory input")}</div>
						<pre className="traj-inspector-pre">{input}</pre>
					</div>
				)}
				{output !== undefined && output !== "" && (
					<div className="traj-inspector-block">
						<div className="traj-inspector-block-label">{t("trajectory output")}</div>
						<pre className="traj-inspector-pre">{output}</pre>
					</div>
				)}
			</div>
		</div>
	);
}

/** 分支树单行(第二层):缩进层级 + kind 图标 + 预览 + 子分支角标(点击折叠)
 *  + 悬停操作(branchAt 重答 / fork 新会话)。当前叶脉冲高亮,活动路径全亮,
 *  路径外淡显——与第一层 BranchBar 同一 id 空间(view key)。 */
function TreeNodeRow({
	node,
	depth,
	isLeaf,
	onPath,
	childCount,
	isCollapsed,
	onToggleCollapse,
	onJump,
	onBranchTo,
	onForkAt,
}: {
	node: MessageTreeNode;
	depth: number;
	isLeaf: boolean;
	onPath: boolean;
	childCount: number;
	isCollapsed: boolean;
	onToggleCollapse(id: string): void;
	onJump(id: string): void;
	onBranchTo?(id: string): void;
	onForkAt?(id: string): void;
}): ReactNode {
	const kind = treeKindOf(node.entry);
	return (
		<div
			className={`traj-trow${onPath ? "" : " traj-trow--off"}${isLeaf ? " traj-trow--leaf" : ""}`}
			style={{ paddingLeft: depth * 14 }}
		>
			<button type="button" className="traj-trow-main" onClick={() => onJump(node.id)} title={t("trajectory jump")}>
				<Icon
					name={(TREE_ICON[kind] ?? "file-list-2") as Parameters<typeof Icon>[0]["name"]}
					className={`h-3 w-3 flex-shrink-0 gui-mtree-icon gui-mtree-icon--${kind}`}
				/>
				<span className="traj-trow-text">{treeTextOf(node.entry)}</span>
				{childCount > 1 && (
					<span
						className={`traj-trow-badge${isCollapsed ? " traj-trow-badge--closed" : ""}`}
						title={isCollapsed ? t("trajectory expand branch") : t("trajectory collapse branch")}
						onClick={e => {
							e.stopPropagation();
							onToggleCollapse(node.id);
						}}
					>
						{childCount}
					</span>
				)}
			</button>
			{(onBranchTo || onForkAt) && (
				<span className="traj-trow-actions">
					{onBranchTo && (
						<button
							type="button"
							className="traj-trow-action"
							title={t("branch re-answer here")}
							aria-label={t("branch re-answer here")}
							onClick={() => onBranchTo(node.id)}
						>
							<Icon name="git-branch" className="h-3 w-3" />
						</button>
					)}
					{onForkAt && (
						<button
							type="button"
							className="traj-trow-action"
							title={t("fork session here")}
							aria-label={t("fork session here")}
							onClick={() => onForkAt(node.id)}
						>
							<Icon name="git-fork" className="h-3 w-3" />
						</button>
					)}
				</span>
			)}
		</div>
	);
}

export function TrajectoryView({
	entries,
	modelId,
	roundDurations,
	onJumpToEntry,
	leafId,
	activePathIds,
	onBranchTo,
	onForkAt,
}: {
	entries: readonly unknown[];
	modelId?: string;
	/** daemon agent_end 冻结的整轮用时(Map 或持久化 [ms,ms][] 形态)。 */
	roundDurations?: RoundDurationMap;
	/** Jump the transcript to an entry id (ChatView wiring). Absent =
	 *  flat event list without jump affordances (backward compatible). */
	onJumpToEntry?: (entryId: string) => void;
	/** Layer-2 分支树模式:当前叶子(view key id;null/undefined = 尾部)。
	 *  与 activePathIds 一起驱动行高亮/淡显。 */
	leafId?: string | null;
	/** 活动路径(根→叶)上的条目 id 集;未提供 = 全部视为在路径上。 */
	activePathIds?: ReadonlySet<string>;
	/** branchAt 重答:把会话叶移到该节点并回填编辑器(TUI navigateTree parity)。 */
	onBranchTo?(id: string): void;
	/** forkAt:从该节点分叉新会话。 */
	onForkAt?(id: string): void;
}): ReactNode {
	const [mode, setMode] = useState<"timeline" | "tree">("timeline");
	const { turns, stats } = useMemo(() => buildTrajectoryTree(entries, roundDurations), [entries, roundDurations]);
	// 折叠的 turn 集合(默认全部展开;点击行头折叠/展开)。
	const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
	// 检视器选中记录(id;null = 未选中)。
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// Overview 时间轴拖拽区间(聚焦模式;null = 全量)。
	const [range, setRange] = useState<TimelineRange | null>(null);
	// 树模式:已折叠节点集 + 展平行(buildMessageTree 按 parentId 投影)。
	const [collapsedNodes, setCollapsedNodes] = useState<ReadonlySet<string>>(new Set());
	const treeRoots = useMemo(() => buildMessageTree(entries), [entries]);
	const treeRows = useMemo(() => {
		const rows: { node: MessageTreeNode; depth: number }[] = [];
		const walk = (nodes: readonly MessageTreeNode[], depth: number): void => {
			for (const node of nodes) {
				rows.push({ node, depth });
				if (!collapsedNodes.has(node.id)) walk(node.children, depth + 1);
			}
		};
		walk(treeRoots, 0);
		return rows;
	}, [treeRoots, collapsedNodes]);
	// 分支列布局(垂直生长,不右延):第一子继承父列,其余子开新列;
	// 每列 = 一个 flex column,节点按序垂直堆叠。列首显示分支来源摘要。
	const treeLanes = useMemo(() => {
		const laneOf = new Map<string, number>();
		const nextLane = { n: 0 };
		const assign = (nodes: readonly MessageTreeNode[], inherited: number): void => {
			for (const node of nodes) {
				const lane = laneOf.get(node.id) ?? inherited;
				laneOf.set(node.id, lane);
				for (let i = 0; i < node.children.length; i++) {
					if (i === 0) {
						laneOf.set(node.children[i]!.id, lane);
						assign([node.children[i]!], lane);
					} else {
						const nl = nextLane.n++;
						laneOf.set(node.children[i]!.id, nl);
						assign([node.children[i]!], nl);
					}
				}
			}
		};
		for (const root of treeRoots) {
			if (!laneOf.has(root.id)) {
				laneOf.set(root.id, nextLane.n++);
				assign([root], laneOf.get(root.id)!);
			}
		}
		const byLane = new Map<number, { node: MessageTreeNode; isLeaf: boolean; onPath: boolean }[]>();
		const walk = (nodes: readonly MessageTreeNode[]): void => {
			for (const node of nodes) {
				const lane = laneOf.get(node.id) ?? 0;
				const arr = byLane.get(lane) ?? [];
				arr.push({
					node,
					isLeaf: leafId != null && node.id === leafId,
					onPath: !activePathIds || activePathIds.has(node.id),
				});
				byLane.set(lane, arr);
				if (!collapsedNodes.has(node.id)) walk(node.children);
			}
		};
		walk(treeRoots);
		return [...byLane.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([lane, rows]) => ({
				lane,
				rows,
				head: lane === 0 ? undefined : rows[0] ? treeTextOf(rows[0].node.entry).slice(0, 60) : undefined,
			}));
	}, [treeRoots, collapsedNodes, leafId, activePathIds]);
	// 性能:进入树模式时默认折叠非当前路径的多子分支(懒展开——折叠节点
	// 的子行只在展开后渲染)。以 leafId 作会话标识,切会话重新播种。
	const seededCollapseFor = useRef<string | null>(null);
	useEffect(() => {
		if (mode !== "tree") return;
		const sessionKey = leafId ?? "";
		if (seededCollapseFor.current === sessionKey) return;
		seededCollapseFor.current = sessionKey;
		const ids = new Set<string>();
		const walk = (nodes: readonly MessageTreeNode[]): void => {
			for (const node of nodes) {
				if (node.children.length > 1 && activePathIds && !activePathIds.has(node.id)) ids.add(node.id);
				walk(node.children);
			}
		};
		walk(treeRoots);
		setCollapsedNodes(ids);
	}, [mode, treeRoots, activePathIds, leafId]);

	// Esc 退出检视/聚焦(Esc 优先级:先清区间,再清选中——与模态键盘契约一致)。
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			if (range) setRange(null);
			else if (selectedId) setSelectedId(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [range, selectedId]);

	const turnDurationOf = (turn: number): number | undefined => turns.find(g => g.turn === turn)?.roundDurationMs;
	const selected = selectedId !== null ? turns.flatMap(g => g.events).find(e => e.id === selectedId) : undefined;

	const toggleTurn = (turn: number): void => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(turn)) next.delete(turn);
			else next.add(turn);
			return next;
		});
	};

	return (
		<div className="relative flex h-full min-h-0 flex-col">
			{/* Timeline | Tree 切换(第二层):同一棵 entry 树的两个投影轴。 */}
			<div className="traj-mode-row">
				<div className="traj-mode-toggle" role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={mode === "timeline"}
						className={`traj-mode-btn${mode === "timeline" ? " traj-mode-btn--on" : ""}`}
						onClick={() => setMode("timeline")}
					>
						<Icon name="history" className="h-3 w-3" />
						{t("trajectory mode timeline")}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "tree"}
						className={`traj-mode-btn${mode === "tree" ? " traj-mode-btn--on" : ""}`}
						onClick={() => setMode("tree")}
					>
						<Icon name="git-branch" className="h-3 w-3" />
						{t("trajectory mode tree")}
					</button>
				</div>
			</div>
			{/* 顶部统计(DSH Trajectory 同款):Duration / Turns / Calls / Model */}
			<div className="grid grid-cols-2 gap-1.5 px-2.5 pb-2 pt-2">
				<div className="gui-ctx-stat">
					<div className="gui-ctx-stat-v">{durationText(stats.durationSec * 1000)}</div>
					<div className="gui-ctx-stat-l">{t("trajectory duration")}</div>
				</div>
				<div className="gui-ctx-stat">
					<div className="gui-ctx-stat-v">{stats.turns}</div>
					<div className="gui-ctx-stat-l">{t("trajectory turns")}</div>
				</div>
				<div className="gui-ctx-stat">
					<div className="gui-ctx-stat-v">{stats.calls}</div>
					<div className="gui-ctx-stat-l">{t("trajectory calls")}</div>
				</div>
				<div className="gui-ctx-stat">
					<div className="gui-ctx-stat-v truncate text-[11px]">{modelId ?? "—"}</div>
					<div className="gui-ctx-stat-l">{t("trajectory model")}</div>
				</div>
			</div>
			{/* Overview 时间轴:拖拽区间聚焦 / 悬停时刻提示 / 单击整轮。 */}
			{turns.length > 0 && (
				<div className="px-2.5 pb-1.5">
					<TimelineOverview turns={turns} selection={range} onSelectionChange={setRange} />
				</div>
			)}
			{/* 聚焦 chip:区间激活时显示,指示当前视图窗口,✕ 清除。 */}
			{range && (
				<div className="px-2.5 pb-1.5">
					<div className="traj-focus-chip">
						<Icon name="target" className="h-3 w-3 flex-shrink-0" />
						<span className="traj-focus-time">
							{t("trajectory focus")} {new Date(range.startMs).toLocaleTimeString(undefined, { hour12: false })}{" "}
							– {new Date(range.endMs).toLocaleTimeString(undefined, { hour12: false })}
						</span>
						<button
							type="button"
							className="traj-focus-clear"
							title={t("trajectory clear filter")}
							aria-label={t("trajectory clear filter")}
							onClick={() => {
								setRange(null);
								setSelectedId(null);
							}}
						>
							<Icon name="close" className="h-3 w-3" />
						</button>
					</div>
				</div>
			)}
			{/* 检视面板 = 悬浮浮层(绝对定位覆盖,不挤占事件列表):
			 * 选中即浮在列表上方(底右锚),130ms 进出,滚动独立。 */}
			{selected && (
				<div className="traj-inspector-overlay">
					<InspectorCard
						ev={selected}
						roundDurationMs={turnDurationOf(selected.turn)}
						onClose={() => setSelectedId(null)}
					/>
				</div>
			)}
			<FadeScroll className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3">
				{mode === "tree" ? (
					treeRows.length === 0 ? (
						<p className="px-2 py-5 text-[12px] leading-relaxed text-[var(--color-text-faint)]">
							{t("trajectory empty")}
						</p>
					) : (
						<div className="flex flex-col">
							{treeRows.map(row => (
								<TreeNodeRow
									key={row.node.id}
									node={row.node}
									depth={row.depth}
									isLeaf={leafId != null && row.node.id === leafId}
									onPath={!activePathIds || activePathIds.has(row.node.id)}
									childCount={row.node.children.length}
									isCollapsed={collapsedNodes.has(row.node.id)}
									onToggleCollapse={id =>
										setCollapsedNodes(prev => {
											const next = new Set(prev);
											if (next.has(id)) next.delete(id);
											else next.add(id);
											return next;
										})
									}
									onJump={onJumpToEntry ?? (() => {})}
									onBranchTo={onBranchTo}
									onForkAt={onForkAt}
								/>
							))}
						</div>
					)
				) : turns.length === 0 ? (
					<p className="px-2 py-5 text-[12px] leading-relaxed text-[var(--color-text-faint)]">
						{t("trajectory empty")}
					</p>
				) : (
					<div className="flex flex-col">
						{turns.map(group => {
							const isCollapsed = collapsed.has(group.turn);
							const assistant = group.events.find(ev => ev.kind === "assistant");
							const toolCount = group.events.filter(ev => ev.kind === "tool").length;
							const firstTs = group.firstTs
								? new Date(group.firstTs).toLocaleTimeString(undefined, {
										hour: "2-digit",
										minute: "2-digit",
										second: "2-digit",
									})
								: "";
							const groupDuration =
								group.roundDurationMs ??
								(group.startMs && group.endMs ? group.endMs - group.startMs : undefined);
							const inRange =
								range === null ||
								group.events.some(ev => isTrajectoryEventInRange(ev, range.startMs, range.endMs));
							return (
								<div key={group.turn} className={`traj-turn-group${inRange ? "" : " traj-turn-group--dim"}`}>
									<button
										type="button"
										className="traj-turn-head"
										aria-expanded={!isCollapsed}
										onClick={() => toggleTurn(group.turn)}
									>
										<Icon
											name={isCollapsed ? "arrow-right-s" : "arrow-down-s"}
											className="h-3.5 w-3.5 shrink-0 opacity-60"
										/>
										<span className="traj-turn-tag">
											{group.turn === 0 ? t("trajectory system events") : `Turn ${group.turn}`}
										</span>
										<span className="traj-turn-summary">
											{assistant ? assistant.title : `${group.events.length} events`}
										</span>
										<span className="traj-turn-meta">
											{toolCount > 0 ? `${toolCount} ${t("trajectory calls").toLowerCase()}` : ""}
											{groupDuration !== undefined
												? `${toolCount > 0 ? " · " : ""}${durationText(groupDuration)}`
												: ""}
											{firstTs ? ` · ${firstTs}` : ""}
										</span>
									</button>
									{!isCollapsed && (
										<div className="traj-turn-events">
											{group.events.map(ev => (
												<EventRow
													key={ev.id}
													ev={ev}
													selected={selectedId === ev.id}
													dimmed={
														range !== null && !isTrajectoryEventInRange(ev, range.startMs, range.endMs)
													}
													onSelect={setSelectedId}
													onJumpToEntry={onJumpToEntry}
												>
													{ev.branch && (
														<span className="traj-branch-chip">
															<Icon name="git-fork" className="h-2.5 w-2.5" />
															{t("trajectory branch")}
														</span>
													)}
												</EventRow>
											))}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</FadeScroll>
		</div>
	);
}
