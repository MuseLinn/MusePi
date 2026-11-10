import { ProgressMeter, t } from "@musepi/client-core";
import { fmtCost, fmtDuration } from "@musepi/client-core/src/lib/format";
import type { ReactNode } from "react";
import { useState } from "react";
import { Reveal } from "../../components/Reveal";
import type { SlotComponentProps } from "../../lib/slot-host";
import { Icon } from "../../vendor/oc-icons";

/**
 * 信息卡「子代理」分区(Cordis `chat.session-info.agents`)。
 *
 * 数据由宿主读好:`sessionInfo.agents` 已经是百分比、阻塞态、耗时与成本的
 * 只读投影 —— 分区自己不碰会话流,也不复算进度。内置回退与这里用同一份读数,
 * 停用/编译失败时两边不会分叉。标记与样式沿用 gui-chat.css 的
 * `.gui-session-info-agents`,进度条复用宿主 `ProgressMeter`。
 */
export default function SessionInfoAgentsSection({ sessionInfo }: SlotComponentProps): ReactNode {
	const [open, setOpen] = useState(true);
	const [endedOpen, setEndedOpen] = useState(false);
	const agents = sessionInfo?.agents ?? [];
	if (agents.length === 0) return null;
	const live = agents.filter(row => !row.ended);
	const ended = agents.filter(row => row.ended);
	const openTrajectory = sessionInfo?.openTrajectory;
	return (
		<section className="gui-session-info-section">
			<button
				type="button"
				className="gui-session-info-section-head"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
			>
				<span className="gui-session-info-section-label">{t("general.agents")}</span>
				{live.length > 0 ? (
					<span className="gui-session-info-count gui-session-info-count--live">{live.length}</span>
				) : undefined}
				<Icon
					name="arrow-down-s"
					className={`gui-session-info-chev${open ? "" : " gui-session-info-chev--closed"}`}
				/>
			</button>
			<Reveal open={open}>
				<div className="gui-session-info-agents">
					{live.map(row => (
						<button
							key={row.id}
							type="button"
							className={`gui-session-info-agent${row.blocked ? " gui-session-info-agent--blocked" : ""}`}
							title={row.task}
							onClick={openTrajectory}
						>
							<Icon
								name={row.blocked ? "alert" : "loader-4"}
								className={`gui-session-info-row-icon${row.blocked ? "" : " gui-session-info-spin"}`}
							/>
							<span className="gui-session-info-item-label">
								{row.agent}
								{row.task ? ` · ${row.task}` : ""}
							</span>
							{row.blocked ? (
								// A parked agent has no progress to plot; the state text
								// takes the track's place instead of freezing it.
								<span className="gui-session-info-agent-state">{t("sessionInfo.awaitingApproval")}</span>
							) : (
								<ProgressMeter
									className="gui-session-info-bar"
									value={row.percent}
									label={row.agent}
									valueText={`${row.percent}%`}
								/>
							)}
							<span className="gui-session-info-elapsed">{row.elapsed}</span>
							{row.cost > 0 ? <span className="gui-session-info-elapsed">{fmtCost(row.cost)}</span> : null}
						</button>
					))}
					{ended.length > 0 ? (
						<button
							type="button"
							className="gui-session-info-agent gui-session-info-agent--ended"
							aria-expanded={endedOpen}
							onClick={() => setEndedOpen(value => !value)}
						>
							<Icon
								name="arrow-down-s"
								className={`gui-session-info-chev${endedOpen ? "" : " gui-session-info-chev--closed"}`}
							/>
							<span className="gui-session-info-item-label">{t("general.ended")}</span>
							<span className="gui-session-info-count">{ended.length}</span>
						</button>
					) : null}
					<Reveal open={endedOpen}>
						<ul className="gui-session-info-list">
							{ended.map(row => (
								<li key={row.id}>
									<button
										type="button"
										className="gui-session-info-agent gui-session-info-agent--ended"
										title={row.task}
										onClick={openTrajectory}
									>
										<Icon name="check" className="gui-session-info-row-icon" />
										<span className="gui-session-info-item-label">{row.agent}</span>
										<span className="gui-session-info-elapsed">
											{row.durationMs > 0 ? fmtDuration(row.durationMs) : row.elapsed}
										</span>
										{row.cost > 0 ? (
											<span className="gui-session-info-elapsed">{fmtCost(row.cost)}</span>
										) : null}
									</button>
								</li>
							))}
						</ul>
					</Reveal>
				</div>
			</Reveal>
		</section>
	);
}
