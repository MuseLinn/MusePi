import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Icon } from "../vendor/oc-icons";
import { buildTrajectoryTree, type TrajectoryEvent } from "./trajectory-data";

/** 单条轨迹事件行(折叠树展开后 + 无 onJumpToEntry 时的平铺回退)。 */
function EventRow({
	ev,
	onJumpToEntry,
}: {
	ev: TrajectoryEvent;
	onJumpToEntry?: (entryId: string) => void;
}): ReactNode {
	const row = (
		<div className={`traj-event traj-event--${ev.kind}`}>
			<span className={`traj-tag traj-tag--${ev.kind}`}>
				{ev.kind === "tool" ? (
					<Icon name="hammer" className="h-2.5 w-2.5" />
				) : ev.kind === "system" ? (
					<Icon name="settings-3" className="h-2.5 w-2.5" />
				) : null}
				{ev.kind === "assistant" ? "ASSISTANT" : ev.kind === "tool" ? "TOOL" : "SYSTEM"}
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
	);
	if (!onJumpToEntry || !ev.entryId) return row;
	return (
		<button
			type="button"
			className="traj-event-jump"
			title={t("trajectory jump")}
			aria-label={t("trajectory jump")}
			onClick={() => onJumpToEntry(ev.entryId!)}
		>
			{row}
			<Icon name="arrow-right-s" className="traj-jump-icon" />
		</button>
	);
}

export function TrajectoryView({
	entries,
	modelId,
	onJumpToEntry,
}: {
	entries: readonly unknown[];
	modelId?: string;
	/** Jump the transcript to an entry id (ChatView wiring). Absent =
	 *  flat event list without jump affordances (backward compatible). */
	onJumpToEntry?: (entryId: string) => void;
}): ReactNode {
	const { turns, stats } = useMemo(() => buildTrajectoryTree(entries), [entries]);
	// 折叠的 turn 集合(默认全部展开;点击行头折叠/展开)。
	const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(new Set());
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
					<div className="gui-ctx-stat-v">{stats.durationSec}s</div>
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
			<div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
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
							return (
								<div key={group.turn} className="traj-turn-group">
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
										<span className="traj-turn-tag">Turn {group.turn}</span>
										<span className="traj-turn-summary">
											{assistant ? assistant.title : `${group.events.length} events`}
										</span>
										<span className="traj-turn-meta">
											{toolCount > 0 ? `${toolCount} ${t("trajectory calls").toLowerCase()}` : ""}
											{firstTs ? ` · ${firstTs}` : ""}
										</span>
									</button>
									{!isCollapsed && (
										<div className="traj-turn-events">
											{group.events.map(ev => (
												<EventRow key={ev.id} ev={ev} onJumpToEntry={onJumpToEntry} />
											))}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
