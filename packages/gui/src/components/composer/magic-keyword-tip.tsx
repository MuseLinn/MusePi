import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";

/**
 * Magic-keyword affordance tip (TUI parity: the terminal editor rainbow-
 * highlights standalone `ultrathink` while typing — the desktop composer
 * gets a lightweight prose tip instead). Fires only on the keywords the
 * user actually enables (Settings → magicKeywords.*); matching is the same
 * prose-word-boundary regex the agent uses (no letters/digits/underscore/
 * slash/hyphen/dot/paren adjacency), minus the code-block masking — this is
 * a passive hint, not the functional detection, so a keyword inside a
 * fenced code block showing a hint is harmless.
 */

const KW = (kw: string): RegExp =>
	new RegExp(String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)${kw}(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`, "u");

const ULTRATHINK_RE = KW("ultrathink");
const ORCHESTRATE_RE = KW("orchestrate");
const WORKFLOW_RE = KW("workflowz");

export interface MagicKeywordTipProps {
	text: string;
	/** Per-keyword enable flags from settings (magicKeywords.*). */
	enabled: { ultrathink: boolean; orchestrate: boolean; workflow: boolean };
}

/** Which enabled keywords the current draft contains (prose-boundary). */
function hitsFor(text: string, enabled: MagicKeywordTipProps["enabled"]): string[] {
	const hits: string[] = [];
	if (enabled.ultrathink && ULTRATHINK_RE.test(text)) hits.push("ultrathink");
	if (enabled.orchestrate && ORCHESTRATE_RE.test(text)) hits.push("orchestrate");
	if (enabled.workflow && WORKFLOW_RE.test(text)) hits.push("workflowz");
	return hits;
}

/** One-line description per keyword (i18n). */
function describe(keyword: string): string {
	switch (keyword) {
		case "ultrathink":
			return t("magic keyword ultrathink");
		case "orchestrate":
			return t("magic keyword orchestrate");
		case "workflowz":
			return t("magic keyword workflow");
		default:
			return "";
	}
}

/** Prose tip under the composer input: "⚡ ultrathink — 最大自动思考". */
export function MagicKeywordTip({ text, enabled }: MagicKeywordTipProps): ReactNode {
	const hits = hitsFor(text, enabled);
	if (hits.length === 0) return null;
	return (
		<div className="gui-magic-tip" role="status" aria-live="polite">
			{hits.map(keyword => (
				<span key={keyword} className="gui-magic-tip-row">
					<span className="gui-magic-tip-kw">⚡ {keyword}</span>
					<span className="gui-magic-tip-desc">— {describe(keyword)}</span>
				</span>
			))}
		</div>
	);
}
