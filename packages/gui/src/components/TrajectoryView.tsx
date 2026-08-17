import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { Icon } from "../vendor/oc-icons";
import { buildTrajectory } from "./trajectory-data";
export function TrajectoryView({ entries, modelId }: { entries: readonly unknown[]; modelId?: string }): ReactNode {
	const { events, stats } = useMemo(() => buildTrajectory(entries), [entries]);

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
				{events.length === 0 ? (
					<p className="px-2 py-5 text-[12px] leading-relaxed text-[var(--color-text-faint)]">
						{t("trajectory empty")}
					</p>
				) : (
					<div className="flex flex-col">
						{events.map((ev, idx) => (
							<div key={ev.id} className="traj-row">
								{/* turn 边界:user 消息显示为分界行 */}
								{ev.kind === "user" ? (
									<div className="traj-turn">
										<span className="traj-turn-tag">Turn {ev.turn}</span>
										<span className="traj-user-text">{ev.title}</span>
									</div>
								) : (
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
								)}
								{idx < events.length - 1 && events[idx + 1]?.turn !== ev.turn && ev.kind !== "user" ? (
									<div className="traj-turn-gap" />
								) : null}
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
