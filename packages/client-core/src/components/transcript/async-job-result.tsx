/**
 * `async-job-result` settlement card. Follows the reference clients' rule for
 * background work: a status line carries outcome, agent and duration, the
 * output gets a bounded preview, and the model-facing `<task-result>` envelope
 * never surfaces.
 *
 * A structured output is parsed: a JSON object renders as fields (string
 * values decoded, so `\n` inside them becomes real line breaks) instead of a
 * raw pretty-printed blob. Expansion uses the shared collapse morph.
 */

import type { AsyncJobResultView } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { useCollapseHeight } from "../../lib/use-collapse";

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

/** Parsed JSON output, or null when the body is plain text. Only objects and
 *  arrays are structured; a bare scalar string/JSON number stays verbatim. */
function parseOutput(output: string): unknown {
	const trimmed = output.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
	try {
		const value: unknown = JSON.parse(trimmed);
		return value !== null && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

function JsonValue({ value }: { value: unknown }): ReactNode {
	if (typeof value === "string") {
		// JSON.parse already decoded the escapes: a pretty-printed block would
		// show `\n` literally, a text node shows the intended line breaks.
		return <div className="tr-async-job-text">{value}</div>;
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) {
		return <span className="tr-async-job-scalar">{String(value)}</span>;
	}
	return <pre className="tr-async-job-json">{JSON.stringify(value, null, 2)}</pre>;
}

function JobOutputBody({ output }: { output: string }): ReactNode {
	const parsed = parseOutput(output);
	if (parsed !== null && !Array.isArray(parsed)) {
		return (
			<div className="tr-async-job-fields">
				{Object.entries(parsed as Record<string, unknown>).map(([name, value]) => (
					<div key={name} className="tr-async-job-field">
						<span className="tr-async-job-key">{name}</span>
						<JsonValue value={value} />
					</div>
				))}
			</div>
		);
	}
	if (parsed !== null) {
		return <pre className="tr-async-job-json">{JSON.stringify(parsed, null, 2)}</pre>;
	}
	return <pre className="tr-async-job-text">{output}</pre>;
}

function CollapsibleJobOutput({ output }: { output: string }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const [clamped, setClamped] = useState(true);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	// Preview height cache for the morph endpoints: the hook measures after the
	// clamp class already flipped, so this only reads while the clamp is on.
	const previewHRef = useRef(0);
	useEffect(() => {
		if (clamped && bodyRef.current) previewHRef.current = bodyRef.current.clientHeight;
	});
	useCollapseHeight(expanded, bodyRef, {
		closedHeight: () => previewHRef.current,
		onSettled: open => {
			if (!open) setClamped(true);
		},
	});
	return (
		<>
			<div ref={bodyRef} className={`tr-async-job-body${clamped ? " tr-async-job-body--clamped" : ""}`}>
				<JobOutputBody output={output} />
			</div>
			<button
				type="button"
				className="tr-async-job-more"
				aria-expanded={expanded}
				onClick={() => {
					if (expanded) {
						// The clamp reapplies when the collapse settles.
						setExpanded(false);
					} else {
						// Unclamp first so the morph starts from the preview.
						setClamped(false);
						setExpanded(true);
					}
				}}
			>
				{expanded ? t("transcript.asyncJobShowLess") : t("transcript.asyncJobShowMore")}
			</button>
		</>
	);
}

export function AsyncJobResultCard({ view }: { view: AsyncJobResultView }): ReactNode {
	const tone = toneOf(view.status);
	const output = view.output ?? "";
	const clampable = output.split("\n").length > OUTPUT_CLAMP_LINES || output.length > OUTPUT_CLAMP_CHARS;
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
				clampable ? (
					<CollapsibleJobOutput output={output} />
				) : (
					<div className="tr-async-job-body">
						<JobOutputBody output={output} />
					</div>
				)
			) : null}
			{view.hint ? <div className="tr-async-job-hint">{view.hint.replace(/`/g, "")}</div> : null}
		</div>
	);
}
