import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
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
}: {
	ev: TrajectoryEvent;
	selected: boolean;
	dimmed: boolean;
	onSelect(id: string | null): void;
	onJumpToEntry?: (entryId: string) => void;
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
	);
}

export function TrajectoryView({
	entries,
	modelId,
	roundDurations,
	onJumpToEntry,
}: {
	entries: readonly unknown[];
	modelId?: string;
	/** daemon agent_end 冻结的整轮用时(Map 或持久化 [ms,ms][] 形态)。 */
	roundDurations?: RoundDurationMap;
	/** Jump the transcript to an entry id (ChatView wiring). Absent =
	 *  flat event list without jump affordances (backward compatible). */
	onJumpToEntry?: (entryId: string) => void;
}): ReactNode {
	const { turns, stats } = useMemo(() => buildTrajectoryTree(entries, roundDurations), [entries, roundDurations]);
	// 折叠的 turn 集合(默认全部展开;点击行头折叠/展开)。
	const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
	// 检视器选中记录(id;null = 未选中)。
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// Overview 时间轴拖拽区间(聚焦模式;null = 全量)。
	const [range, setRange] = useState<TimelineRange | null>(null);

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
		<div className="flex h-full min-h-0 flex-col">
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
			{/* 检视面板:选中记录的时刻/回合用时/Input/Output。 */}
			{selected && (
				<div className="px-2.5 pb-1.5">
					<InspectorCard
						ev={selected}
						roundDurationMs={turnDurationOf(selected.turn)}
						onClose={() => setSelectedId(null)}
					/>
				</div>
			)}
			<FadeScroll className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
				{turns.length === 0 ? (
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
												/>
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
