import { fmtCost, fmtDuration, fmtTokens, relTime, t } from "@musepi/desktop-web";
import type { AgentProgress, AgentSnapshot, SubagentLifecyclePayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionStore } from "../lib/session-store";
import { useStore } from "../lib/use-store";
import { Icon } from "../vendor/oc-icons";
import { SubagentPanel } from "./SubagentPanel";

/** Re-render tick so running-tool durations and relative times stay live. */
function useNow(intervalMs: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}

/** Best-effort start timestamp for the in-flight tool (AgentsPanel mirror). */
function toolStartMs(p: AgentProgress): number | null {
	const start = (p as { currentToolStartMs?: unknown }).currentToolStartMs;
	if (typeof start === "number") return start;
	const lastEnd = p.recentTools[0]?.endMs;
	return typeof lastEnd === "number" ? lastEnd : null;
}

function activityLine(
	agent: AgentSnapshot,
	p: AgentProgress | undefined,
	lc: SubagentLifecyclePayload | undefined,
	now: number,
): string {
	if (p?.currentTool) {
		const start = toolStartMs(p);
		if (start !== null) return `${p.currentTool} · ${fmtDuration(Math.max(0, now - start))}`;
		return p.currentTool;
	}
	if (p?.lastIntent) return p.lastIntent;
	if (lc) return lc.status;
	return agent.status;
}

/**
 * Agents Center — a full viewSwap page (BoardPage/ScheduledTasksPage
 * pattern) showing the live subagent roster of the open session as a table:
 * status, activity (current tool · elapsed / last intent), tokens/cost, and
 * last activity. Clicking a row slides the SubagentPanel (transcript +
 * kill/revive/chat) out over the table — the same drawer chrome as the chat
 * view. Data is the session store snapshot (agents/progress/lifecycle), the
 * same source the right-rail AgentsPanel consumes.
 */
export function AgentsCenterPage({
	rpc,
	store,
	onBack,
}: {
	rpc: RpcClient | null;
	store: GuiSessionStore | null;
	onBack(): void;
}): ReactNode {
	const snap = useStore(
		store ? store.subscribe.bind(store) : () => () => {},
		store ? store.getSnapshot.bind(store) : () => null,
	);
	const now = useNow(1000);

	const agents = snap?.agents ?? [];
	const progress = snap?.progress ?? new Map();
	const lifecycle = snap?.lifecycle ?? new Map();

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = selectedId !== null ? (agents.find(a => a.id === selectedId) ?? null) : null;

	const sorted = useMemo(() => {
		const mains: AgentSnapshot[] = [];
		const subs: AgentSnapshot[] = [];
		for (const agent of agents) (agent.kind === "main" ? mains : subs).push(agent);
		subs.sort((a, b) => {
			const ar = a.status === "running" ? 0 : 1;
			const br = b.status === "running" ? 0 : 1;
			if (ar !== br) return ar - br;
			return b.lastActivity - a.lastActivity;
		});
		return [...mains, ...subs];
	}, [agents]);

	const running = agents.filter(a => a.status === "running").length;

	return (
		<div className="gui-agents-center">
			<header className="gui-agents-center-head">
				<button type="button" className="gui-tool-btn" onClick={onBack} aria-label={t("back")} title={t("back")}>
					<Icon name="arrow-left" className="h-4 w-4" />
				</button>
				<div className="gui-agents-center-title">
					<Icon name="ai-agent-fill" className="h-4 w-4 text-[var(--color-accent)]" />
					<h2 className="gui-agents-center-name">{t("agents center")}</h2>
					<span className="gui-agents-center-count">
						{running > 0 ? (
							<>
								<span className="gui-agents-center-live" aria-hidden />
								{t("{count} running · {total} total", { count: running, total: agents.length })}
							</>
						) : (
							t("{count} agents", { count: agents.length })
						)}
					</span>
				</div>
			</header>

			{store === null ? (
				<div className="gui-agents-center-empty">{t("open a session to view its agents")}</div>
			) : sorted.length === 0 ? (
				<div className="gui-agents-center-empty">{t("no subagents")}</div>
			) : (
				<div className="gui-agents-center-table" role="table" aria-label={t("agents center")}>
					<div className="gui-agents-row gui-agents-row--head" role="row">
						<span role="columnheader" aria-hidden />
						<span role="columnheader">{t("agent")}</span>
						<span role="columnheader">{t("activity")}</span>
						<span role="columnheader">{t("usage")}</span>
						<span role="columnheader">{t("last activity")}</span>
					</div>
					{sorted.map(agent => {
						const p = progress.get(agent.id)?.progress;
						const lc = lifecycle.get(agent.id);
						return (
							<button
								key={agent.id}
								type="button"
								role="row"
								className={`gui-agents-row${selectedId === agent.id ? " gui-agents-row--selected" : ""}`}
								onClick={() => setSelectedId(selectedId === agent.id ? null : agent.id)}
							>
								<span className={`ag-dot ag-dot--${agent.status}`} role="cell" />
								<span className="gui-agents-cell gui-agents-cell--name" role="cell">
									<span className="gui-agents-name">{agent.displayName}</span>
									<span className="ag-chip">{t(agent.kind)}</span>
								</span>
								<span className="gui-agents-cell gui-agents-cell--activity" role="cell">
									{activityLine(agent, p, lc, now)}
								</span>
								<span className="gui-agents-cell gui-agents-cell--usage" role="cell">
									{p ? (
										<>
											<span>{fmtTokens(p.tokens)} tok</span>
											<span className="gui-agents-meta-sep">·</span>
											<span>{fmtCost(p.cost)}</span>
										</>
									) : (
										<span className="gui-agents-muted">—</span>
									)}
								</span>
								<span className="gui-agents-cell gui-agents-cell--when" role="cell">
									{relTime(agent.lastActivity)}
								</span>
							</button>
						);
					})}
				</div>
			)}

			{selected && rpc && (
				<SubagentPanel
					agent={selected}
					rpc={rpc}
					progress={progress.get(selected.id)?.progress}
					onClose={() => setSelectedId(null)}
				/>
			)}
		</div>
	);
}
