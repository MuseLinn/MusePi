/**
 * The trace waterfall body: one turn's steps on a single time axis.
 *
 * Presentational only — no dialog shell. The host wraps it (the desktop uses its
 * `DialogFrame`), which keeps this in the shared client where the mobile surface
 * and the future bot lane can reuse it without reaching for a desktop component.
 *
 * A long bar is the answer to "where did the minutes go"; a red one is the
 * answer to "what broke". Untimed steps are drawn as a sliver and counted
 * separately, because a zero-width bar would claim the step took no time.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { fmtDuration } from "../../lib/format.js";
import type { TraceStep, TurnTrace } from "./turn-trace";

function statusLabel(step: TraceStep): string | null {
	if (step.status === "error") return t("transcript.traceFailed");
	return null;
}

/** `12.5k` / `1.2M`: tokens at a glance, never a full seven-digit number. */
function compactTokens(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function fmtCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "—";
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * A duration whose value is known to be incomplete: "0ms" for a turn whose tools
 * recorded nothing reads as "the tools took no time", which is the opposite of
 * the truth. Untimed steps make the number a floor, so it says so ("44.1s+"),
 * and a total with no timed step at all says "untimed" instead of a zero.
 */
function durationStat(ms: number, untimed: number): string {
	if (untimed === 0) return fmtDuration(ms);
	if (ms === 0) return t("transcript.traceUnTimed");
	return `${fmtDuration(ms)}+`;
}

export function TurnTracePanel({ trace, className }: { trace: TurnTrace; className?: string }): ReactNode {
	const { totals } = trace;
	const untimedOf = (kind: TraceStep["kind"]): number =>
		trace.steps.filter(step => step.kind === kind && step.durationMs === undefined).length;
	return (
		<div className={`tr-trace${className ? ` ${className}` : ""}`}>
			<div className="tr-trace-stats">
				<span>
					<span className="tr-trace-stat-label">{t("transcript.traceToolTime")}</span>
					<span className="tr-trace-stat-value">{durationStat(totals.toolMs, untimedOf("tool"))}</span>
				</span>
				<span>
					<span className="tr-trace-stat-label">{t("transcript.traceModelTime")}</span>
					<span className="tr-trace-stat-value">{durationStat(totals.modelMs, untimedOf("model"))}</span>
				</span>
				<span>
					<span className="tr-trace-stat-label">{t("transcript.traceTokens")}</span>
					<span className="tr-trace-stat-value">
						{compactTokens(totals.input)} / {compactTokens(totals.output)}
					</span>
				</span>
				<span>
					<span className="tr-trace-stat-label">{t("transcript.traceCost")}</span>
					<span className="tr-trace-stat-value">{fmtCost(totals.cost)}</span>
				</span>
			</div>

			<ol className="tr-trace-list">
				{trace.steps.map((step, index) => {
					const failed = statusLabel(step);
					return (
						<li
							key={`${step.id}:${index}`}
							className="tr-trace-row"
							data-kind={step.kind}
							data-status={step.status}
						>
							<span className="tr-trace-label" title={step.detail ?? step.label}>
								<span className="tr-trace-name">{step.label}</span>
								{failed !== null && <span className="tr-trace-failed">{failed}</span>}
							</span>
							<span className="tr-trace-axis" aria-hidden="true">
								<span
									className="tr-trace-bar"
									style={{ insetInlineStart: `${step.offsetPct}%`, width: `${step.widthPct}%` }}
								/>
							</span>
							<span className="tr-trace-duration">
								{step.durationMs === undefined ? t("transcript.traceUnTimed") : fmtDuration(step.durationMs)}
							</span>
						</li>
					);
				})}
				{trace.steps.flatMap((step, index) =>
					(step.children ?? []).map(child => (
						<li
							key={`${step.id}:sub:${child.id}:${index}`}
							className="tr-trace-row tr-trace-row--sub"
							data-kind="subagent"
							data-status={child.status}
						>
							<span className="tr-trace-label" title={child.detail ?? child.label}>
								<span className="tr-trace-name">{child.label}</span>
								{child.status === "error" && (
									<span className="tr-trace-failed">{t("transcript.traceFailed")}</span>
								)}
							</span>
							<span className="tr-trace-axis tr-trace-axis--empty" aria-hidden="true" />
							<span className="tr-trace-duration">
								{child.tokens !== undefined && (
									<span className="tr-trace-sub-tokens">{compactTokens(child.tokens)}</span>
								)}
								{fmtDuration(child.durationMs)}
							</span>
						</li>
					)),
				)}
			</ol>

			{totals.untimedSteps > 0 && (
				<p className="tr-trace-note">{t("transcript.traceUntimedNote", { count: String(totals.untimedSteps) })}</p>
			)}
			{totals.failed > 0 && (
				<p className="tr-trace-note tr-trace-note--failed">
					{t("transcript.traceFailedNote", { count: String(totals.failed) })}
				</p>
			)}
		</div>
	);
}
