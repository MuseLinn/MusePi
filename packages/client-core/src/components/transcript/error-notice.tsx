/**
 * Error presentation shared by the two surfaces that report a failed turn.
 *
 * A failed turn used to reach the user as an ordinary assistant message: it took
 * the reply's avatar and gutter, and printed whatever the provider sent in raw
 * monospace. That reads as the model having said it, and a provider error is not
 * the model's words — it is a fact about the request. Both surfaces now go
 * through here so the same failure cannot look like two different things.
 *
 * Two ideas from the reference implementations are in play:
 *
 *  - The captured-response merge in packages/ai can hand us several lines, where
 *    only the first is the reason and the rest is diagnostic. So the text is
 *    split: the summary is what stays visible, the remainder folds.
 *  - A long single-line provider body (a JSON envelope, typically) must not be
 *    truncated at a fixed column, because the tail is where the provider's own
 *    error message usually is. It folds by length here instead of being cut.
 *
 * Summary versus detail is decided by shape, not by pattern-matching provider
 * text: matching message strings is exactly the practice the transport-error
 * layer warns against, because renaming a provider's phrasing silently
 * reclassifies the failure.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";

/** Above this, a single unbroken line is folded rather than shown whole. */
const SUMMARY_MAX = 220;

export interface ErrorText {
	/** The line that stays visible. */
	summary: string;
	/** Everything else, or empty when there is nothing to fold away. */
	detail: string;
}

/**
 * Split raw error text into a visible summary and foldable detail.
 *
 * Lines come first because that is how the captured-response merge composes
 * them. A single line longer than {@link SUMMARY_MAX} is cut at a word boundary
 * when one is near, and the tail becomes the detail — never dropped.
 */
export function splitErrorText(raw: string | undefined): ErrorText {
	const text = (raw ?? "").trim();
	if (!text) return { summary: "", detail: "" };

	const lines = text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	const [first = "", ...rest] = lines;

	if (lines.length > 1) {
		return { summary: first, detail: rest.join("\n") };
	}
	if (first.length <= SUMMARY_MAX) {
		return { summary: first, detail: "" };
	}

	// Single long line: keep the cut on a space so the visible half is readable,
	// falling back to a hard cut when the text has no spaces to break on.
	const window = first.slice(0, SUMMARY_MAX);
	const lastSpace = window.lastIndexOf(" ");
	const head = lastSpace > SUMMARY_MAX / 2 ? window.slice(0, lastSpace) : window;
	return { summary: `${head}…`, detail: first.slice(head.length).replace(/^\s+/, "") };
}

export interface ErrorNoticeProps {
	/** `error` reads as a failure, `aborted` as something the user stopped. */
	kind: "error" | "aborted" | "retry";
	/** Chip label. Defaults to a translated phrase when omitted. */
	label?: string;
	/** Trailing metadata, e.g. the retry attempt counter. */
	meta?: ReactNode;
	raw?: string | undefined;
	/** When given, wins over `raw` so a caller can supply its own split. */
	text?: ErrorText;
}

/**
 * One failed turn, rendered as a fact about the request rather than as speech.
 *
 * The disclosure is a plain button rather than `<details>` so the open state is
 * controllable — a provider error that folds itself shut the moment it is
 * expanded cannot be expanded again after a re-render.
 */
export function ErrorNotice({ kind, label, meta, raw, text }: ErrorNoticeProps): ReactNode {
	const [open, setOpen] = useState(false);
	const split = text ?? splitErrorText(raw);
	if (!split.summary && !split.detail) return null;

	const chip =
		label ??
		(kind === "aborted" ? t("request interrupted") : kind === "retry" ? t("model error") : t("request failed"));

	return (
		<div className="tr-stop" role="alert" data-error-kind={kind}>
			<span className={`tr-chip ${kind === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{chip}</span>
			<span className="tr-stop-msg">{split.summary}</span>
			{meta !== undefined && meta !== null ? <span className="tr-stop-meta">{meta}</span> : null}
			{split.detail ? (
				<>
					<button
						type="button"
						className="tr-stop-toggle"
						aria-expanded={open}
						onClick={() => setOpen(value => !value)}
					>
						{open ? t("hide details") : t("show details")}
					</button>
					{open ? (
						<pre className="tr-stop-detail" tabIndex={0}>
							{split.detail}
						</pre>
					) : null}
				</>
			) : null}
		</div>
	);
}
