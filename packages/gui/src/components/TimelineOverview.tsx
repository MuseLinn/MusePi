import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";
import type { TrajectoryTurnGroup } from "./trajectory-data";

/**
 * 轨迹 Overview 时间轴(DSH Trajectory Overview parity):固定顶栏,把
 * 真实记录的起止时刻按时间从左→右投影成横向条带——每 turn 一段(agent_end
 * 冻结的回合时长命中时该段 = 完整回合跨度),记录在各自时刻落点。
 *
 * 交互:悬停段/点 120ms 后出时刻+时长提示;在条带上拖拽 = 选中时间区间
 * (上游列表按区间高亮/置灰);单击某 turn 段 = 选中该整轮;单击空白 = 清除。
 * 纯展示层,零数据依赖(只消费 buildTrajectoryTree 的输出)。
 */
export interface TimelineRange {
	startMs: number;
	endMs: number;
}

const MIN_SEGMENT_PX = 3;

/** 记录点颜色与轨迹行标签同源(assistant/tool/system/user)。 */
const KIND_COLOR: Record<string, string> = {
	user: "var(--color-accent)",
	assistant: "#b39ddb",
	tool: "#d4a35c",
	system: "var(--color-text-faint)",
};

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

function clockDetail(ms: number): string {
	const d = new Date(ms);
	const base = d.toLocaleTimeString(undefined, {
		hour12: false,
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 时长口语化:0.8s / 12.3s / 1m 23s / 1h 02m(与状态栏用时同语感)。 */
export function durationText(ms: number): string {
	if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSec = Math.round(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;
	if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m ${String(totalSec % 60).padStart(2, "0")}s`;
	return `${Math.floor(totalSec / 3600)}h ${String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0")}m`;
}

interface HoverInfo {
	/** 提示气泡锚定的横向百分比(0-100)。 */
	leftPct: number;
	title: string;
	time: string;
	duration: string;
}

export function TimelineOverview({
	turns,
	selection,
	onSelectionChange,
}: {
	turns: readonly TrajectoryTurnGroup[];
	selection: TimelineRange | null;
	onSelectionChange(sel: TimelineRange | null): void;
}): ReactNode {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const [draft, setDraft] = useState<TimelineRange | null>(null);
	const [hover, setHover] = useState<HoverInfo | null>(null);
	const [hoverVisible, setHoverVisible] = useState(false);
	const dragAnchor = useRef<{ ms: number; x: number } | null>(null);
	const movedRef = useRef(0);
	const hideTimer = useRef<Timer | null>(null);

	// 时间域 = 全部 turn 的 [最早 start, 最晚 end];无有效时刻返回 null(不渲染条带)。
	const domain = useMemo(() => {
		let min = Infinity;
		let max = -Infinity;
		let any = false;
		for (const turn of turns) {
			if (turn.startMs !== undefined) {
				min = Math.min(min, turn.startMs);
				any = true;
			}
			const end = turn.endMs ?? turn.startMs;
			if (end !== undefined) max = Math.max(max, end);
		}
		if (!any || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
		return { min, max, span: max - min };
	}, [turns]);
	if (!domain) return null;

	const pctOf = (ms: number): number => ((ms - domain.min) / domain.span) * 100;

	const showHover = (info: HoverInfo): void => {
		if (hideTimer.current) {
			clearTimeout(hideTimer.current);
			hideTimer.current = null;
		}
		setHover(info);
		setHoverVisible(true);
	};
	const hideHover = (): void => {
		// 悬停提示按「500ms 级」的克制节奏:离开条带后延迟隐藏,供在提示间滑移。
		if (hideTimer.current) clearTimeout(hideTimer.current);
		hideTimer.current = setTimeout(() => setHoverVisible(false), 140);
	};

	const msAtClientX = (clientX: number): number => {
		const el = trackRef.current;
		if (!el) return domain.min;
		const rect = el.getBoundingClientRect();
		const frac = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
		return domain.min + frac * domain.span;
	};

	const commitRange = (a: number, b: number): void => {
		const startMs = Math.min(a, b);
		const endMs = Math.max(a, b);
		onSelectionChange(endMs - startMs >= 1 ? { startMs, endMs } : null);
	};

	return (
		<div className="traj-ov-wrap" role="img" aria-label={t("trajectory timeline")}>
			<div
				ref={trackRef}
				className="traj-ov-track"
				onPointerDown={e => {
					if (e.button !== 0) return;
					dragAnchor.current = { ms: msAtClientX(e.clientX), x: e.clientX };
					movedRef.current = 0;
					e.currentTarget.setPointerCapture(e.pointerId);
				}}
				onPointerMove={e => {
					if (dragAnchor.current) {
						movedRef.current += Math.abs(e.clientX - dragAnchor.current.x);
						dragAnchor.current.x = e.clientX;
						const ms = msAtClientX(e.clientX);
						const a = dragAnchor.current.ms;
						const start = Math.min(a, ms);
						const end = Math.max(a, ms);
						setDraft(end - start >= 1 ? { startMs: start, endMs: end } : null);
					}
				}}
				onPointerUp={e => {
					const anchor = dragAnchor.current;
					if (!anchor) return;
					dragAnchor.current = null;
					const moved = movedRef.current;
					const target = e.target;
					// 单击段 = 选中该整轮;单击空白 = 清除;拖动(>3px)= 区间。
					if (moved < 3) {
						const seg = target instanceof Element ? target.closest<HTMLElement>(".traj-ov-segment") : null;
						if (seg) {
							const turn = seg.dataset.turn;
							const group = turns.find(g => String(g.turn) === turn);
							if (group?.startMs !== undefined && group.endMs !== undefined) {
								commitRange(group.startMs, group.endMs);
							}
						} else {
							onSelectionChange(null);
						}
						setDraft(null);
						return;
					}
					const ms = msAtClientX(e.clientX);
					commitRange(anchor.ms, ms);
					setDraft(null);
				}}
				onPointerLeave={() => hideHover()}
			>
				{/* 时间域刻度:起止时钟(两端淡字,单行不换行)。 */}
				<span className="traj-ov-edge traj-ov-edge--start">{clock(domain.min)}</span>
				<span className="traj-ov-edge traj-ov-edge--end">{clock(domain.max)}</span>
				{turns.map(group => {
					if (group.startMs === undefined) return null;
					// 闭包内属性收窄会失效(TS 不把对象属性收窄带进箭头函数),
					// 提前拷成局部常量供事件处理器使用。
					const start = group.startMs;
					const end = group.endMs ?? start;
					const left = pctOf(start);
					const width = Math.max(pctOf(end) - left, MIN_SEGMENT_PX);
					const active =
						selection !== null && start <= selection.endMs && (group.endMs ?? start) >= selection.startMs;
					return (
						<div
							key={group.turn}
							className={`traj-ov-segment${active ? " traj-ov-segment--active" : ""}`}
							data-turn={group.turn}
							style={{ left: `${left}%`, width: `${width}%` }}
							onPointerEnter={() => {
								showHover({
									leftPct: Math.min(98, left + width / 2),
									title: `Turn ${group.turn}`,
									time: `${clock(start)} → ${clock(end)}`,
									duration: durationText(group.endMs !== undefined ? group.endMs - start : 0),
								});
							}}
						>
							{/* 记录点:每个带 tsMs 的事件一落点,颜色按 kind。 */}
							{group.events.map(ev => {
								if (ev.tsMs === undefined) return null;
								const t = ev.tsMs;
								const dl = pctOf(t);
								return (
									<span
										key={ev.id}
										className={`traj-ov-dot traj-ov-dot--${ev.kind}`}
										style={{
											left: `${dl}%`,
											background: KIND_COLOR[ev.kind] ?? "var(--color-text-faint)",
										}}
										onPointerEnter={() => {
											showHover({
												leftPct: Math.min(98, dl),
												title: ev.title,
												time: clockDetail(t),
												duration: durationText(0),
											});
										}}
									/>
								);
							})}
						</div>
					);
				})}
				{/* 拖拽中的区间覆盖层。 */}
				{draft && (
					<div
						className="traj-ov-draft"
						style={{
							left: `${pctOf(draft.startMs)}%`,
							width: `${Math.max(pctOf(draft.endMs) - pctOf(draft.startMs), 0.5)}%`,
						}}
					/>
				)}
				{/* 已提交区间覆盖层。 */}
				{selection && (
					<div
						className="traj-ov-range"
						style={{
							left: `${pctOf(selection.startMs)}%`,
							width: `${Math.max(pctOf(selection.endMs) - pctOf(selection.startMs), 0.5)}%`,
						}}
					/>
				)}
			</div>
			{/* 悬停提示放到 wrap(track 是 overflow:hidden,提示在 track 内会被
			 * 顶部裁掉 — 2026-08-21 实测 stripped)。wrap 同宽同坐标空间。 */}
			{hover && hoverVisible && (
				<div className="traj-ov-tip" style={{ left: `${hover.leftPct}%` }}>
					<div className="traj-ov-tip-title">{hover.title}</div>
					<div className="traj-ov-tip-time">{hover.time}</div>
					<div className="traj-ov-tip-dur">{hover.duration}</div>
				</div>
			)}
		</div>
	);
}
