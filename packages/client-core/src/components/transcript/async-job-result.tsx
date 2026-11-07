/**
 * `async-job-result` settlement card. Follows the reference clients' rule for
 * background work: a status line carries outcome, agent and duration, the
 * output gets a bounded preview, and the model-facing `<task-result>` envelope
 * never surfaces.
 */

import type { AsyncJobResultView } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";

type Tone = "ok" | "err" | "warn" | "accent";

const OUTPUT_CLAMP_LINES = 8;
const OUTPUT_CLAMP_CHARS = 700;

function toneOf(status: string): Tone {
	switch (status.toLowerCase()) {
		case "completed":
			return "ok";
		case "failed":
			return "err";
		case "cancelled":
		case "canceled":
			return "warn";
		case "running":
			return "accent";
		default:
			return "ok";
	}
}

function glyphOf(tone: Tone): string {
	switch (tone) {
		case "err":
			return "✕";
		case "warn":
			return "⊘";
		case "accent":
			return "•";
		default:
			return "✓";
	}
}

function statusLabel(status: string): string {
	switch (status.toLowerCase()) {
		case "completed":
			return t("transcript.asyncJobCompleted");
		case "failed":
			return t("transcript.asyncJobFailed");
		case "cancelled":
		case "canceled":
			return t("transcript.asyncJobCancelled");
		case "running":
			return t("transcript.asyncJobRunning");
		default:
			return status;
	}
}

export function AsyncJobResultCard({ view }: { view: AsyncJobResultView }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const tone = toneOf(view.status);
	const output = view.output ?? "";
	const lineCount = output.split("\n").length;
	const clampable = lineCount > OUTPUT_CLAMP_LINES || output.length > OUTPUT_CLAMP_CHARS;
	const clamped = clampable && !expanded;
	const meta = [view.lines ? t("transcript.asyncJobLines", { count: String(view.lines) }) : undefined, view.size]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className={`tr-async-result tr-async-job tr-async-job--${tone}`}>
			<div className="tr-async-result-row">
				<span className="tr-async-result-done" aria-hidden>
					{glyphOf(tone)}
				</span>
				<span className="tr-async-result-text">{view.label}</span>
				{view.type ? <span className="tr-async-result-tag">[{view.type}]</span> : null}
				{view.duration ? <span className="tr-async-result-dur">({view.duration})</span> : null}
				<span className="tr-async-job-status">{statusLabel(view.status)}</span>
				{meta ? <span className="tr-async-result-dur">{meta}</span> : null}
			</div>
			{output ? (
				<pre className={`tr-async-job-output${clamped ? " tr-async-job-output--clamped" : ""}`}>{output}</pre>
			) : null}
			{clampable ? (
				<button
					type="button"
					className="tr-async-job-more"
					aria-expanded={expanded}
					onClick={() => setExpanded(open => !open)}
				>
					{expanded ? t("transcript.asyncJobShowLess") : t("transcript.asyncJobShowMore")}
				</button>
			) : null}
			{view.hint ? <div className="tr-async-job-hint">{view.hint.replace(/`/g, "")}</div> : null}
		</div>
	);
}
