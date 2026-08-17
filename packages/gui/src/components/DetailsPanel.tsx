import { AgentsPanel, t } from "@musepi/collab-web";
import type { AgentSnapshot, SessionState, SubagentLifecyclePayload, SubagentProgressPayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";

/**
 * Right-hand details pane (prototype §3, 300px): session metadata card on
 * top, agent panel below. Pure-data props — no daemon coupling.
 */
export function DetailsPanel({
	agents,
	progress,
	lifecycle,
	state,
}: {
	agents: readonly AgentSnapshot[];
	progress: ReadonlyMap<string, SubagentProgressPayload>;
	lifecycle: ReadonlyMap<string, SubagentLifecyclePayload>;
	state: SessionState | null;
}): ReactNode {
	const meta: Array<[string, string]> = [];
	if (state?.cwd) meta.push([t("cwd"), state.cwd]);
	if (state?.model?.id) meta.push([t("model"), `${state.model.provider}/${state.model.id}`]);
	// SessionState carries participants; surface a count when present.
	const participants = state?.participants?.length ?? 0;
	if (participants > 0) meta.push([t("participants"), String(participants)]);

	return (
		<aside className="gui-details">
			{meta.length > 0 && (
				<section className="gui-details-section">
					<h3 className="gui-details-title">{t("Session")}</h3>
					<dl className="gui-details-meta">
						{meta.map(([k, v]) => (
							<div key={k} className="gui-details-meta-row">
								<dt>{k}</dt>
								<dd title={v}>{v}</dd>
							</div>
						))}
					</dl>
				</section>
			)}
			<section className="gui-details-section">
				<h3 className="gui-details-title">{t("Agents")}</h3>
				<AgentsPanel
					agents={agents}
					progress={progress}
					lifecycle={lifecycle}
					selectedId={null}
					onSelect={() => {}}
				/>
			</section>
		</aside>
	);
}
