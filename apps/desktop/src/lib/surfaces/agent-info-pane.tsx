/**
 * Agent info pane — the session's own tab.
 *
 * Opened by the chat capsule: the one place that answers "who is this agent
 * and what is it running with". Identity head, the current model (shown as the
 * `provider/id` reference, never a bare id), the model's real thinking ladder,
 * and the session metadata that used to sit in the composer as chips.
 *
 * Writes are limited to the two controls the pane owns (model, thinking
 * level); everything else is a readout or an entrance to a surface that
 * already exists.
 */
import { t } from "@musepi/client-core";
import { fmtCost } from "@musepi/client-core/src/lib/format";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentAvatar } from "../../components/AgentAvatar";
import { clampLadderValue, LadderSlider } from "../../components/LadderSlider";
import { ModelSelector } from "../../components/ModelSelector";
import { ModelBrandIcon } from "../../components/model-brand-icon";
import { Icon, type IconName } from "../../vendor/oc-icons";
import { agentSignalsFromSnapshot } from "../agent-signals";
import { thinkingOrbStateFromSession } from "../companion";
import { pathBaseName } from "../project-label";
import type { RpcClient } from "../rpc";
import type { GuiSessionState } from "../session-store";

interface ThinkingInfo {
	ceiling?: string | null;
	efforts?: string[];
	level?: string | null;
	auto?: boolean;
	resolved?: string | null;
	model?: { id: string; name?: string; provider?: string } | null;
}

interface SessionUsage {
	model?: string | null;
	tokens?: number | null;
	contextWindow?: number | null;
	percent?: number | null;
	usage?: { cost?: number } | null;
}

interface AgentInfoPaneProps {
	rpc: RpcClient;
	sessionId: string;
	cwd?: string | null;
	title?: string | null;
	/** Live session snapshot — the pane reads the orb state, the pending
	 *  approvals and the plan/goal flags from it, all of which the chat head
	 *  already subscribes to. */
	snap?: GuiSessionState | null;
	onOpenSurface?(id: string): void;
	onOpenSettings?(section?: string): void;
	onAddProvider?(): void;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Compact token count ("128K", "1.2M") for the usage row. */
function formatTokens(n: number | null | undefined): string | null {
	if (n == null || !Number.isFinite(n) || n < 0) return null;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(Math.round(n));
}

/** A readout row: label, value, optional leading icon. */
function InfoRow({
	icon,
	label,
	value,
	title,
}: {
	icon: IconName;
	label: string;
	value: ReactNode;
	title?: string;
}): ReactNode {
	return (
		<div className="gui-agent-info-row" title={title}>
			<Icon name={icon} className="gui-agent-info-row-icon" />
			<span className="gui-agent-info-row-label">{label}</span>
			<span className="gui-agent-info-row-value">{value}</span>
		</div>
	);
}

export function AgentInfoPane({
	rpc,
	sessionId,
	cwd = null,
	title = null,
	snap = null,
	onOpenSurface,
	onOpenSettings,
	onAddProvider,
}: AgentInfoPaneProps): ReactNode {
	const [info, setInfo] = useState<ThinkingInfo | null>(null);
	const [usage, setUsage] = useState<SessionUsage | null>(null);
	const [infoError, setInfoError] = useState<string | null>(null);
	const [usageError, setUsageError] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [retrying, setRetrying] = useState(false);
	const aliveRef = useRef(true);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	/** Read both session views. Returns the first failure message (null when
	 *  both settled) so a write followed by a failed re-read can say so —
	 *  the pane must never look merely "slow" after a hard failure. */
	const refresh = useCallback(async (): Promise<string | null> => {
		const [thinking, context] = await Promise.allSettled([
			rpc.request<ThinkingInfo>("session.thinkingInfo", { sessionId }),
			rpc.request<SessionUsage | null>("session.contextUsage", { sessionId }),
		]);
		if (!aliveRef.current) return null;
		const thinkingFailure = thinking.status === "rejected" ? errorText(thinking.reason) : null;
		const usageFailure = context.status === "rejected" ? errorText(context.reason) : null;
		if (thinking.status === "fulfilled") setInfo(thinking.value ?? null);
		if (context.status === "fulfilled") setUsage(context.value ?? null);
		setInfoError(thinkingFailure);
		setUsageError(usageFailure);
		return thinkingFailure ?? usageFailure;
	}, [rpc, sessionId]);

	useEffect(() => {
		setInfo(null);
		setUsage(null);
		setInfoError(null);
		setUsageError(null);
		void refresh();
	}, [refresh]);

	const retry = useCallback((): void => {
		setFailed(null);
		setRetrying(true);
		void refresh().finally(() => {
			if (aliveRef.current) setRetrying(false);
		});
	}, [refresh]);

	// A finished turn is the natural refresh point for the usage readout.
	const previousWorking = useRef(snap?.working === true);
	useEffect(() => {
		const working = snap?.working === true;
		if (previousWorking.current && !working) void refresh();
		previousWorking.current = working;
	}, [snap?.working, refresh]);

	const efforts = useMemo(() => info?.efforts ?? [], [info]);
	const ceiling = info?.ceiling ?? null;
	const configured = info?.auto === true ? "auto" : clampLadderValue(efforts, ceiling, info?.level ?? null);
	const modelRef = info?.model
		? `${info.model.provider ? `${info.model.provider}/` : ""}${info.model.id}`
		: (usage?.model ?? null);
	const modelName = info?.model?.name ?? info?.model?.id ?? null;

	const notify = useCallback((message: string): void => {
		setFailed(message);
		window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: message }));
	}, []);

	/** A switch that landed still has to re-read the daemon's re-clamped level
	 *  and window; if that read fails the content is stale and the user is told
	 *  instead of being left with a quiet readout. */
	const afterSwitch = useCallback((): void => {
		void refresh().then(error => {
			if (error && aliveRef.current) notify(t("general.agentInfoRefreshFailed", { detail: error }));
		});
	}, [refresh, notify]);

	// Model-switch refusals are reported HERE (the pane can show the message
	// beside the list); the selector rolls its own highlight back.
	const onSwitchError = useCallback(
		(error: unknown): void => {
			if (aliveRef.current) notify(t("general.agentInfoModelSwitchFailed", { detail: errorText(error) }));
		},
		[notify],
	);

	// Level writes are SERIAL: the daemon clamps per model, so two overlapping
	// writes could settle in the order the network answered rather than the
	// order the user moved the knob.
	const thinkingChain = useRef<Promise<void>>(Promise.resolve());
	const thinkingSeq = useRef(0);
	const infoRef = useRef<ThinkingInfo | null>(info);
	infoRef.current = info;
	const setThinking = useCallback(
		(level: string | null): void => {
			const seq = thinkingSeq.current + 1;
			thinkingSeq.current = seq;
			const previous = infoRef.current;
			setFailed(null);
			// Optimistic: the knob and the readout move now; a refusal rolls the
			// whole thinking block back to the daemon's last answer.
			setInfo(current => (current ? { ...current, auto: level === "auto", level } : current));
			thinkingChain.current = thinkingChain.current.then(async () => {
				try {
					await rpc.request("session.setThinkingLevel", { sessionId, thinkingLevel: level });
					const error = await refresh();
					if (error && aliveRef.current && seq === thinkingSeq.current)
						notify(t("general.agentInfoRefreshFailed", { detail: error }));
				} catch (error) {
					// Only the newest write may roll the readout back — an older
					// refusal arriving late must not undo a newer choice.
					if (aliveRef.current && seq === thinkingSeq.current) setInfo(previous);
					if (aliveRef.current) notify(t("general.agentInfoThinkingFailed", { detail: errorText(error) }));
				}
			});
		},
		[rpc, sessionId, refresh],
	);

	const pendingApprovals = snap?.approvals.length ?? 0;
	const status =
		pendingApprovals > 0
			? t("general.agentCapsuleWaiting")
			: snap?.working
				? t("general.agentCapsuleWorking")
				: t("general.agentCapsuleIdle");
	const statusKey = pendingApprovals > 0 ? "waiting" : snap?.working ? "working" : "idle";
	const orb = thinkingOrbStateFromSession(snap);
	const signals = useMemo(() => agentSignalsFromSnapshot(snap, { now: Date.now() }), [snap]);
	const sessionTitle = title?.trim() || t("general.sessionInfoUntitled");

	const contextWindow = usage?.contextWindow ?? null;
	const tokens = usage?.tokens ?? null;
	const percent =
		usage?.percent ?? (tokens != null && contextWindow ? Math.round((tokens / contextWindow) * 100) : null);
	const mode = snap?.state?.planMode
		? t("general.planMode")
		: snap?.state?.goalMode?.enabled
			? t("general.goalMode")
			: t("general.defaultMode");

	return (
		<div className="gui-agent-info">
			<header className="gui-agent-info-head">
				<AgentAvatar state={orb} size={32} seed={sessionId} signals={signals} />
				<div className="gui-agent-info-identity">
					<span className="gui-agent-info-name">{t("general.assistant")}</span>
					<span className="gui-agent-info-status" data-state={statusKey}>
						{status}
					</span>
					<span className="gui-agent-info-title" title={sessionTitle}>
						{sessionTitle}
					</span>
				</div>
			</header>

			{(infoError || usageError) && (
				<p className="gui-agent-info-note gui-agent-info-error">
					<span role="alert">{t("general.agentInfoUnavailable")}</span>
					<button type="button" className="gui-agent-info-link" onClick={retry} disabled={retrying}>
						<Icon name="refresh" className="gui-agent-info-row-icon" />
						<span>{t("general.retry")}</span>
					</button>
				</p>
			)}

			<section className="gui-agent-info-section">
				<div className="gui-agent-info-section-head">
					<span>{t("general.agentInfoModel")}</span>
				</div>
				<div className="gui-agent-info-model">
					{modelRef ? (
						<>
							<ModelBrandIcon
								provider={info?.model?.provider ?? modelRef.split("/")[0] ?? ""}
								modelId={info?.model?.id ?? modelRef.split("/").pop() ?? ""}
								size={14}
							/>
							<span className="gui-agent-info-model-name" title={modelRef}>
								{modelName ?? modelRef}
							</span>
							<span className="gui-agent-info-model-ref" title={modelRef}>
								{modelRef}
							</span>
						</>
					) : (
						<span className="gui-agent-info-note">
							{info === null && !infoError ? t("sessionInfo.loading") : t("sessionInfo.unavailable")}
						</span>
					)}
				</div>
				<ModelSelector
					inline
					rpc={rpc}
					sessionId={sessionId}
					currentModelId={modelRef}
					onSelect={() => afterSwitch()}
					onSwitchError={onSwitchError}
					onAddProvider={onAddProvider}
				/>
			</section>

			<section className="gui-agent-info-section">
				<div className="gui-agent-info-section-head">
					<span>{t("general.agentInfoThinking")}</span>
				</div>
				{info === null ? (
					<p className="gui-agent-info-note">
						{infoError ? t("sessionInfo.unavailable") : t("sessionInfo.loading")}
					</p>
				) : (
					<LadderSlider
						efforts={efforts}
						value={configured}
						resolved={info.resolved ?? null}
						ceiling={ceiling}
						onCommit={setThinking}
					/>
				)}
			</section>

			<section className="gui-agent-info-section">
				<div className="gui-agent-info-section-head">
					<span>{t("general.agentInfoSession")}</span>
				</div>
				{cwd ? (
					<InfoRow icon="folder" label={t("general.agentInfoWorkspace")} value={pathBaseName(cwd)} title={cwd} />
				) : null}
				<InfoRow
					icon="donut-chart"
					label={t("general.agentInfoUsage")}
					value={
						tokens != null
							? `${formatTokens(tokens) ?? "0"}${
									contextWindow ? ` / ${formatTokens(contextWindow)}` : ""
								}${percent != null ? ` · ${percent}%` : ""}`
							: t("sessionInfo.unavailable")
					}
				/>
				{usage?.usage && typeof usage.usage.cost === "number" ? (
					<InfoRow icon="bar-chart-2" label={t("general.agentInfoCost")} value={fmtCost(usage.usage.cost)} />
				) : null}
				{pendingApprovals > 0 ? (
					<button
						type="button"
						className="gui-agent-info-row gui-agent-info-row--action"
						onClick={() => window.dispatchEvent(new CustomEvent("musepi-gui-focus-approvals"))}
					>
						<Icon name="alert" className="gui-agent-info-row-icon" />
						<span className="gui-agent-info-row-label">{t("general.agentInfoApprovals")}</span>
						<span className="gui-agent-info-row-value">{pendingApprovals}</span>
					</button>
				) : null}
				<InfoRow icon="fingerprint" label={t("general.agentInfoSessionId")} value={sessionId} title={sessionId} />
				<InfoRow icon="settings-3" label={t("general.agentInfoMode")} value={mode} />
			</section>

			<section className="gui-agent-info-section">
				<div className="gui-agent-info-section-head">
					<span>{t("general.agentInfoOpen")}</span>
				</div>
				<div className="gui-agent-info-links">
					{(
						[
							["agents", "ai-agent", t("general.agents")],
							["context", "donut-chart", t("general.agentInfoContext")],
							["jobs", "task", t("general.agentInfoJobs")],
						] as const
					).map(([surface, icon, label]) => (
						<button
							key={surface}
							type="button"
							className="gui-agent-info-link"
							onClick={() => onOpenSurface?.(surface)}
						>
							<Icon name={icon} className="gui-agent-info-row-icon" />
							<span>{label}</span>
						</button>
					))}
					<button type="button" className="gui-agent-info-link" onClick={() => onOpenSettings?.("memory")}>
						<Icon name="brain" className="gui-agent-info-row-icon" />
						<span>{t("general.agentInfoMemory")}</span>
					</button>
				</div>
			</section>

			{failed ? (
				<p className="gui-agent-info-note gui-agent-info-error" role="alert">
					{failed}
				</p>
			) : null}
		</div>
	);
}
