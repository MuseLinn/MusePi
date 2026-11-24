/**
 * The trace body: one turn's steps, grouped the way the turn actually ran.
 *
 * Presentational only — no dialog shell. The host wraps it (the desktop uses its
 * `DialogFrame`), which keeps this in the shared client where the mobile surface
 * and the future bot lane can reuse it without reaching for a desktop component.
 *
 * Three hierarchy decisions, each answering something the first version got
 * wrong:
 *
 * 1. **A turn total, then a split.** Four equal numbers have no reader. The
 *    span is stated once, and one bar shows how much of it the tools took, how
 *    much the model took, and how much belongs to neither (queueing, waiting on
 *    a person). The remainder is drawn as empty track, never filled in.
 * 2. **Rounds, not a flat alternation.** A model request and the tool calls it
 *    fired are one unit of work; interleaving them flat makes the eye re-scan
 *    every line. Each request opens a round, its tools sit under it, and a
 *    hairline separates rounds.
 * 3. **Magnitude, not a wall-clock axis.** Steps inside one turn differ by
 *    thousands of times (23ms next to 5 minutes), so an absolute axis renders
 *    every bar as an invisible sliver. Bars are scaled to the turn's longest
 *    step instead, which is the question people actually ask: which one ate the
 *    time. Position-in-time stays in the data for a future timeline view.
 *
 * Failures are never colour-only: the row carries the word as well.
 */
import { Brain, ChevronRight, CircleAlert, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { fmtDuration } from "../../lib/format.js";
import type { TraceStep, TraceSubStep, TurnTrace } from "./turn-trace";

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

/** A request and the work it set off. Tools that ran before any request keep a
 *  lead round of their own rather than being dropped. */
interface TraceRound {
	key: string;
	model?: TraceStep;
	tools: TraceStep[];
}

function groupRounds(steps: readonly TraceStep[]): TraceRound[] {
	const rounds: TraceRound[] = [];
	let current: TraceRound | null = null;
	for (const step of steps) {
		if (step.kind === "model") {
			current = { key: `${step.id}:round`, model: step, tools: [] };
			rounds.push(current);
			continue;
		}
		if (current === null) {
			current = { key: `lead:${step.id}`, tools: [] };
			rounds.push(current);
		}
		current.tools.push(step);
	}
	return rounds;
}

/** The model id without its routing group: `group/deepseek-v4.1-flash` reads as
 *  `deepseek-v4.1-flash`, which is the part a person recognises. */
function shortModel(model: string): string {
	const slashed = model.split("/");
	return slashed[slashed.length - 1] ?? model;
}

function ToolGlyph({ kind }: { kind: TraceStep["kind"] }): ReactNode {
	return kind === "model" ? (
		<Brain size={12} aria-hidden="true" className="tr-trace-glyph" />
	) : (
		<Terminal size={12} aria-hidden="true" className="tr-trace-glyph" />
	);
}

function SubRow({ child, maxMs }: { child: TraceSubStep; maxMs: number }): ReactNode {
	const width = Math.max(2, Math.min(100, (child.durationMs / maxMs) * 100));
	return (
		<li className="tr-trace-row tr-trace-row--sub" data-kind="subagent" data-status={child.status}>
			<span className="tr-trace-lead" aria-hidden="true">
				<ChevronRight size={11} className="tr-trace-sub-mark" />
			</span>
			<span className="tr-trace-main">
				<span className="tr-trace-name" title={child.detail ?? child.label}>
					{child.label}
				</span>
				{child.tokens !== undefined && <span className="tr-trace-meta">{compactTokens(child.tokens)}</span>}
			</span>
			<span className="tr-trace-gauge" aria-hidden="true">
				<span className="tr-trace-gauge-fill tr-trace-gauge-fill--sub" style={{ width: `${width}%` }} />
			</span>
			<span className="tr-trace-duration">{fmtDuration(child.durationMs)}</span>
		</li>
	);
}

function StepRow({
	step,
	maxMs,
	modelLabel,
}: {
	step: TraceStep;
	maxMs: number;
	/** Shown instead of the model id: the round names it once, and a repeated
	 *  id five times down the list is noise, not information. */
	modelLabel?: string;
}): ReactNode {
	const isModel = step.kind === "model";
	const failed = step.status === "error";
	// A floor keeps a 23ms step visible next to a five-minute one; scaled to the
	// longest step, not to the turn span.
	const width = step.durationMs === undefined ? 2 : Math.max(2, Math.min(100, (step.durationMs / maxMs) * 100));
	return (
		<li
			className={`tr-trace-row${isModel ? " tr-trace-row--model" : ""}`}
			data-kind={step.kind}
			data-status={step.status}
		>
			<span className="tr-trace-lead" aria-hidden="true">
				<ToolGlyph kind={step.kind} />
			</span>
			<span className="tr-trace-main">
				<span className="tr-trace-name" title={isModel ? step.label : (step.detail ?? step.label)}>
					{isModel ? (modelLabel ?? shortModel(step.label)) : step.label}
				</span>
				{!isModel && step.detail !== undefined && step.detail !== step.label && (
					<span className="tr-trace-detail" title={step.detail}>
						{step.detail}
					</span>
				)}
				{failed && <span className="tr-trace-failed">{t("transcript.traceFailed")}</span>}
				{isModel && step.tokens !== undefined && (
					<span className="tr-trace-meta">
						{compactTokens(step.tokens.input)} ↓ / {compactTokens(step.tokens.output)} ↑
					</span>
				)}
			</span>
			<span className="tr-trace-gauge" aria-hidden="true">
				<span
					className={`tr-trace-gauge-fill${failed ? " tr-trace-gauge-fill--failed" : ""}`}
					style={{ width: `${width}%` }}
				/>
			</span>
			<span className="tr-trace-duration">
				{step.durationMs === undefined ? t("transcript.traceUnTimed") : fmtDuration(step.durationMs)}
			</span>
		</li>
	);
}

export function TurnTracePanel({ trace, className }: { trace: TurnTrace; className?: string }): ReactNode {
	const { totals } = trace;
	const untimedOf = (kind: TraceStep["kind"]): number =>
		trace.steps.filter(step => step.kind === kind && step.durationMs === undefined).length;

	const spanMs = Math.max(1, trace.endedAt - trace.startedAt);
	// Shares of the TURN, not of the timed total: the leftover is queueing and
	// waiting on a person, and hiding it would overstate the two known parts.
	const toolShare = Math.min(100, (totals.toolMs / spanMs) * 100);
	const modelShare = Math.min(100 - toolShare, (totals.modelMs / spanMs) * 100);
	const restShare = Math.max(0, 100 - toolShare - modelShare);
	// A big remainder is real information (queueing, waiting on a person); a
	// sliver is rounding. Only the former earns a legend entry.
	const showRest = restShare >= 5;
	const maxMs = Math.max(
		1,
		...trace.steps.map(step => step.durationMs ?? 0),
		...trace.steps.flatMap(step => (step.children ?? []).map(child => child.durationMs)),
	);
	const rounds = groupRounds(trace.steps);
	// The model is worth naming when it CHANGES (a mid-turn switch is real
	// information); repeating the same id on every round is not. Computed in a
	// pass, not inline, so rendering stays free of side effects.
	const modelLabels = new Map<string, string>();
	let previousModel: string | null = null;
	for (const round of rounds) {
		if (round.model === undefined) continue;
		modelLabels.set(
			round.key,
			round.model.label === previousModel ? t("transcript.traceRequest") : shortModel(round.model.label),
		);
		previousModel = round.model.label;
	}

	return (
		<div className={`tr-trace${className ? ` ${className}` : ""}`}>
			{/* The dialog shell renders no visible title (DialogFrame carries only an
			 * accessible label), so the panel supplies one — the same contract the
			 * other dialogs follow. */}
			<div className="tr-trace-title">
				<span className="tr-trace-title-name">{t("transcript.traceTitle")}</span>
				<span className="tr-trace-meta">{fmtCost(totals.cost)}</span>
			</div>
			<header className="tr-trace-hero">
				<div className="tr-trace-hero-main">
					<span className="tr-trace-hero-total">{fmtDuration(trace.endedAt - trace.startedAt)}</span>
				</div>
				<div className="tr-trace-hero-side">
					<span className="tr-trace-meta">
						{compactTokens(totals.input)} ↓ / {compactTokens(totals.output)} ↑
					</span>
				</div>
				<div className="tr-trace-split" aria-hidden="true">
					<span className="tr-trace-split-tools" style={{ width: `${toolShare}%` }} />
					<span className="tr-trace-split-model" style={{ width: `${modelShare}%` }} />
					{showRest && <span className="tr-trace-split-rest" style={{ width: `${restShare}%` }} />}
				</div>
				<div className="tr-trace-legend">
					<span className="tr-trace-legend-tools">
						<span className="tr-trace-legend-dot" aria-hidden="true" />
						{t("transcript.traceToolTime")} {durationStat(totals.toolMs, untimedOf("tool"))}
					</span>
					<span className="tr-trace-legend-model">
						<span className="tr-trace-legend-dot" aria-hidden="true" />
						{t("transcript.traceModelTime")} {durationStat(totals.modelMs, untimedOf("model"))}
					</span>
					{showRest && (
						<span className="tr-trace-legend-rest">
							<span className="tr-trace-legend-dot" aria-hidden="true" />
							{t("transcript.traceRestTime")} {fmtDuration(spanMs - totals.toolMs - totals.modelMs)}
						</span>
					)}
				</div>
			</header>

			<ol className="tr-trace-list">
				{rounds.map((round, index) => (
					<li key={round.key} className="tr-trace-round" data-first={index === 0 ? "true" : undefined}>
						{round.model !== undefined && (
							<StepRow step={round.model} maxMs={maxMs} modelLabel={modelLabels.get(round.key)} />
						)}
						{round.tools.length > 0 && (
							<ol className="tr-trace-tools">
								{round.tools.map((step, stepIndex) => (
									<StepRow key={`${step.id}:${stepIndex}`} step={step} maxMs={maxMs} />
								))}
								{round.tools.flatMap((step, stepIndex) =>
									(step.children ?? []).map((child, childIndex) => (
										<SubRow key={`${step.id}:sub:${child.id}:${childIndex}`} child={child} maxMs={maxMs} />
									)),
								)}
							</ol>
						)}
					</li>
				))}
			</ol>

			{(totals.untimedSteps > 0 || totals.failed > 0) && (
				<footer className="tr-trace-foot">
					{totals.failed > 0 && (
						<span className="tr-trace-note tr-trace-note--failed">
							<CircleAlert size={12} aria-hidden="true" />
							{t("transcript.traceFailedNote", { count: String(totals.failed) })}
						</span>
					)}
					{totals.untimedSteps > 0 && (
						<span className="tr-trace-note">
							{t("transcript.traceUntimedNote", { count: String(totals.untimedSteps) })}
						</span>
					)}
				</footer>
			)}
		</div>
	);
}
