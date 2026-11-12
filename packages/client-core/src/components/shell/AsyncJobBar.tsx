import { ChevronDown, ChevronRight, Terminal, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { type AsyncJobItem, type JobsRpc, jobStartMs, jobTypeLabel, useAsyncJobs } from "../../lib/async-jobs";
import { fmtDuration } from "../../lib/format";

/**
 * Background-job HUD above the composer.
 *
 * Two surfaces, one state: the expanded card lists each running job with its
 * command, live duration and a cancel action; collapsing leaves the chip
 * (`后台 Bash · 1`) so the transcript keeps its vertical space. A host with a
 * detail surface passes `onOpenDetails` (desktop opens the jobs panel tab);
 * hosts without one get an inline sheet with the live output tail.
 *
 * The component renders nothing while no job runs — an idle session has no
 * background HUD, and the poll stops with the component.
 */
export function AsyncJobBar({
	client,
	sessionId,
	onOpenDetails,
	className,
}: {
	client: JobsRpc | null;
	sessionId: string | null;
	/** Host-provided detail surface; omitted → the inline sheet. */
	onOpenDetails?(job: AsyncJobItem): void;
	className?: string;
}): ReactNode {
	const { running, cancel, loadOutput } = useAsyncJobs(client, sessionId);
	const [collapsed, setCollapsed] = useState(false);
	const [selected, setSelected] = useState<AsyncJobItem | null>(null);
	const [output, setOutput] = useState<string>("");
	const [outputLoading, setOutputLoading] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		if (running.length === 0) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [running.length]);

	useEffect(() => {
		if (!selected || !client || !sessionId) return;
		let alive = true;
		const read = (): void => {
			void loadOutput(selected.id).then(result => {
				if (!alive) return;
				setOutputLoading(false);
				if (result?.output !== undefined) setOutput(result.output);
			});
		};
		setOutput("");
		setOutputLoading(true);
		read();
		const timer = window.setInterval(read, 1000);
		return () => {
			alive = false;
			window.clearInterval(timer);
		};
	}, [selected, client, sessionId, loadOutput]);

	if (running.length === 0) return null;
	const primaryType = jobTypeLabel(running[0]?.type ?? "bash");

	return (
		<div className={`sh-jobbar${className ? ` ${className}` : ""}`}>
			{!collapsed && (
				<div className="sh-jobcard">
					<div className="sh-jobcard-head">
						<Terminal size={14} aria-hidden />
						<span className="sh-jobcard-title">
							{t("general.backgroundJobsRunning", {
								type: primaryType,
								count: String(running.length),
							})}
						</span>
						<button
							type="button"
							className="sh-jobcard-collapse"
							title={t("general.backgroundJobsCollapse")}
							aria-label={t("general.backgroundJobsCollapse")}
							onClick={() => setCollapsed(true)}
						>
							<ChevronDown size={14} />
						</button>
					</div>
					<ul className="sh-joblist">
						{running.map(job => (
							<li key={job.id} className="sh-jobrow">
								<span className="sh-jobdot" data-status={job.status} aria-hidden />
								<span className="sh-jobcmd" title={job.label}>
									$ {job.label || job.id}
								</span>
								<span className="sh-jobtime">{fmtDuration(now - jobStartMs(job))}</span>
								<button
									type="button"
									className="sh-jobaction"
									title={t("general.backgroundJobsCancel")}
									aria-label={t("general.backgroundJobsCancel")}
									onClick={() => void cancel(job.id)}
								>
									<X size={13} />
								</button>
								<button
									type="button"
									className="sh-jobaction"
									title={t("general.backgroundJobsDetails")}
									aria-label={t("general.backgroundJobsDetails")}
									onClick={() => (onOpenDetails ? onOpenDetails(job) : setSelected(job))}
								>
									<ChevronRight size={14} />
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
			<button
				type="button"
				className="sh-jobs-chip"
				aria-expanded={!collapsed}
				onClick={() => setCollapsed(value => !value)}
			>
				<Terminal size={13} aria-hidden />
				<span>{t("general.backgroundJobsChip", { type: primaryType })}</span>
				<span className="sh-jobs-chip-count">{running.length}</span>
			</button>

			{selected !== null && (
				<div className="sh-job-sheet-backdrop" role="presentation" onClick={() => setSelected(null)}>
					<div
						className="sh-job-sheet"
						role="dialog"
						aria-modal="true"
						aria-label={t("general.backgroundJobsDetails")}
						onClick={event => event.stopPropagation()}
					>
						<div className="sh-job-sheet-head">
							<span className="sh-job-sheet-title">{selected.label || selected.id}</span>
							<button
								type="button"
								className="sh-jobaction"
								title={t("general.backgroundJobsCancel")}
								aria-label={t("general.backgroundJobsCancel")}
								onClick={() => {
									void cancel(selected.id);
									setSelected(null);
								}}
							>
								<X size={14} />
							</button>
						</div>
						<div className="sh-job-sheet-meta">
							<span>{selected.status}</span>
							<span>{fmtDuration(now - jobStartMs(selected))}</span>
							{selected.outputBytes !== undefined && (
								<span>{t("general.backgroundJobsOutputBytes", { count: String(selected.outputBytes) })}</span>
							)}
						</div>
						<pre className="sh-job-sheet-output">
							{outputLoading && output === ""
								? t("general.backgroundJobsLoading")
								: output || t("general.backgroundJobsNoOutput")}
						</pre>
					</div>
				</div>
			)}
		</div>
	);
}
