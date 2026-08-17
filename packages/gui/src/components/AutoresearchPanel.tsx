import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { DialogFrame } from "./DialogFrame";

/**
 * Autoresearch dashboard (desktop adaptation): the TUI extension renders a
 * status widget + Ctrl+Shift+X overlay; the GUI gets the same data via the
 * daemon `autoresearch.status` RPC and shows an experiment panel — active
 * session (goal, primary metric, segment budget) and the run history
 * (command, status, metric). Triggered by typing /autoresearch in the
 * composer (same detection as /usage).
 */

interface ArStatus {
	active: {
		branch: string | null;
		goal: string | null;
		primaryMetric: string;
		metricUnit: string;
		direction: string;
		preferredCommand: string | null;
		currentSegment: number;
		maxIterations: number | null;
		notes: string;
		createdAt: number;
	} | null;
	runs: {
		segment: number;
		command: string;
		status: string | null;
		startedAt: number;
		durationMs: number | null;
		exitCode: number | null;
		timedOut: boolean;
		metric: number | null;
	}[];
}

function fmtDuration(ms: number | null): string {
	if (ms === null) return "—";
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

function fmtWhen(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
	return new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function statusLabel(status: string | null): string {
	switch (status) {
		case "keep":
			return t("autoresearch status keep");
		case "discard":
			return t("autoresearch status discard");
		case "crash":
			return t("autoresearch status crash");
		case "checks_failed":
			return t("autoresearch status checks failed");
		case "running":
			return t("autoresearch status running");
		default:
			return status ?? "—";
	}
}

export function AutoresearchPanel({
	open,
	onClose,
	rpc,
	cwd,
}: {
	open: boolean;
	onClose(): void;
	rpc?: { request(method: string, params?: Record<string, unknown>): Promise<unknown> };
	cwd?: string;
}): ReactNode {
	const [status, setStatus] = useState<ArStatus | null>(null);
	const [loading, setLoading] = useState(false);

	useEffect(() => {
		if (!open || !rpc) return;
		let alive = true;
		setLoading(true);
		void rpc
			.request("autoresearch.status", { cwd })
			.then(res => {
				if (alive) setStatus(res as ArStatus);
			})
			.catch(() => {
				if (alive) setStatus(null);
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [open, rpc, cwd]);

	return (
		<DialogFrame open={open} onClose={onClose} label={t("autoresearch")} className="w-[560px] max-w-[92vw]">
			<div className="gui-ar-panel">
				<div className="gui-ar-title">
					<span className="gui-ar-title-name">{t("autoresearch")}</span>
					{status?.active && (
						<span className="gui-ar-title-branch">{status.active.branch ?? t("autoresearch no branch")}</span>
					)}
				</div>
				{loading ? (
					<div className="gui-ar-empty">{t("loading…")}</div>
				) : !status?.active ? (
					<div className="gui-ar-empty">
						{t("autoresearch empty")}
						<div className="gui-ar-empty-hint">{t("autoresearch empty hint")}</div>
					</div>
				) : (
					<>
						{status.active.goal && <div className="gui-ar-goal">{status.active.goal}</div>}
						<div className="gui-ar-meta">
							<span className="gui-ar-meta-chip">
								{t("autoresearch metric")}: {status.active.primaryMetric}
								{status.active.metricUnit ? ` (${status.active.metricUnit})` : ""}
							</span>
							<span className="gui-ar-meta-chip">
								{t("autoresearch segment")}: {status.active.currentSegment}
								{status.active.maxIterations !== null ? ` / ${status.active.maxIterations}` : ""}
							</span>
							{status.active.direction && (
								<span className="gui-ar-meta-chip">
									{status.active.direction === "lower" ? "↓" : "↑"} {t("autoresearch direction")}
								</span>
							)}
						</div>
						{status.active.notes && <div className="gui-ar-notes">{status.active.notes}</div>}
						<div className="gui-ar-runs">
							<div className="gui-ar-runs-title">{t("autoresearch runs")}</div>
							{status.runs.length === 0 ? (
								<div className="gui-ar-empty">{t("autoresearch no runs")}</div>
							) : (
								status.runs.map((r, i) => (
									<div key={`${r.startedAt}-${i}`} className="gui-ar-run">
										<div className="gui-ar-run-head">
											<span className="gui-ar-run-seg">#{r.segment}</span>
											<span className="gui-ar-run-cmd" title={r.command}>
												{r.command}
											</span>
											<span className={`gui-ar-run-status gui-ar-run-status--${r.status ?? "pending"}`}>
												{statusLabel(r.status)}
											</span>
										</div>
										<div className="gui-ar-run-meta">
											<span>{fmtWhen(r.startedAt)}</span>
											<span>{fmtDuration(r.durationMs)}</span>
											{r.metric !== null && (
												<span className="gui-ar-run-metric">
													{status.active!.primaryMetric}: {r.metric.toFixed(4)}
												</span>
											)}
											{r.exitCode !== null && r.exitCode !== 0 && (
												<span className="gui-ar-run-err">exit {r.exitCode}</span>
											)}
											{r.timedOut && <span className="gui-ar-run-err">{t("autoresearch timed out")}</span>}
										</div>
									</div>
								))
							)}
						</div>
					</>
				)}
			</div>
		</DialogFrame>
	);
}
