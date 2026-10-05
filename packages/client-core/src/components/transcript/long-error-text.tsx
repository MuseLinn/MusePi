import type { ReactNode } from "react";
import { useId, useMemo, useState } from "react";
import { t } from "../../i18n/index.js";

/**
 * Above this an error starts collapsed. A provider failure can carry a whole
 * response body or a JSON parse dump of hundreds of thousands of characters;
 * shown in full, one such error buries the rest of the conversation.
 */
const COLLAPSE_AFTER_CHARS = 1_000;
const PREVIEW_MAX_CHARS = 400;
const PREVIEW_MAX_LINES = 6;

/**
 * The start of an error long enough to collapse, or null when the error is short
 * enough to show in full.
 *
 * The character cap comes before the line cap because a provider body is usually
 * one enormous line: capping lines alone would leave a single 200k-character row.
 * Both run, so the preview stays readable either way.
 */
export function getLongErrorPreview(text: string): string | null {
	if (text.length <= COLLAPSE_AFTER_CHARS) return null;
	let end = PREVIEW_MAX_CHARS;
	// Do not split a surrogate pair (emoji, rare CJK) in half.
	const lastCode = text.charCodeAt(end - 1);
	if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
	const preview = text.slice(0, end).split("\n").slice(0, PREVIEW_MAX_LINES).join("\n");
	return `${preview.trimEnd()}…`;
}

export interface LongErrorTextProps {
	text: string;
	/** Renders the visible part: the preview while collapsed, the full text once expanded. */
	children: (visibleText: string) => ReactNode;
}

/**
 * Shows a long error collapsed to its opening lines, with a button to reveal the
 * rest. A short error renders unchanged.
 *
 * The fold is keyed on the text rather than on a boolean, so a different error
 * arriving in the same place starts collapsed again instead of inheriting the
 * previous one's open state. The full text is never rendered while collapsed, so
 * a huge error costs nothing until someone asks to read it.
 */
export function LongErrorText({ text, children }: LongErrorTextProps): ReactNode {
	const [expandedText, setExpandedText] = useState<string | null>(null);
	const expanded = expandedText === text;
	const preview = useMemo(() => getLongErrorPreview(text), [text]);
	const contentId = useId();

	if (preview === null) return <>{children(text)}</>;

	// aria-live="off": inside a status region, expanding must not make a screen
	// reader read the whole error aloud.
	return (
		<div className="tr-error-fold" aria-live="off">
			{/* The full text scrolls inside its own box so the collapse button stays
			 * right under it. tabIndex lets keyboard users scroll that box. */}
			<div
				id={contentId}
				tabIndex={expanded ? 0 : undefined}
				className={expanded ? "tr-error-fold-full" : undefined}
			>
				{children(expanded ? text : preview)}
			</div>
			<button
				type="button"
				className="tr-error-fold-toggle"
				aria-expanded={expanded}
				aria-controls={contentId}
				onClick={() => setExpandedText(expanded ? null : text)}
			>
				{expanded ? t("show less") : t("show more")}
			</button>
		</div>
	);
}
