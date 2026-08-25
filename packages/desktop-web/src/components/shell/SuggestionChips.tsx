import type { ReactNode } from "react";
import { useState } from "react";
import { t, type TranslationKey } from "../../i18n/index.js";

/**
 * Empty-state draft suggestion chips (openchamber DraftPresetChips parity,
 * absorbed from the gui WelcomeComposer). Built-in entries are i18n-keyed
 * so labels/prompts localize at render; one tap fills the composer draft
 * via {@link onPick} and the user edits/sends from there. The first 8 chips
 * show collapsed; `+` reveals the rest with a staggered blur-in and morphs
 * into a collapse toggle.
 */

interface SuggestionDef {
	labelKey: TranslationKey;
	promptKey: TranslationKey;
}

/** Default collapsed set — the first 8 chips. */
const DEFAULT_SUGGESTIONS: SuggestionDef[] = [
	{ labelKey: "chip explore codebase", promptKey: "suggest explore codebase" },
	{ labelKey: "chip catch me up", promptKey: "suggest catch me up" },
	{ labelKey: "chip weigh options", promptKey: "suggest weigh options" },
	{ labelKey: "chip start feature planning", promptKey: "suggest start feature planning" },
	{ labelKey: "chip create goal", promptKey: "suggest create goal" },
	{ labelKey: "chip schedule task", promptKey: "suggest schedule task" },
	{ labelKey: "chip debug issue", promptKey: "suggest debug issue" },
	{ labelKey: "chip review changes", promptKey: "suggest review changes" },
];

/** Extra suggestions revealed by the `+` expansion. */
const EXTRA_SUGGESTIONS: SuggestionDef[] = [
	{ labelKey: "chip write tests", promptKey: "suggest write tests" },
	{ labelKey: "chip refactor", promptKey: "suggest refactor" },
	{ labelKey: "chip performance", promptKey: "suggest performance" },
	{ labelKey: "chip web search", promptKey: "suggest web search" },
	{ labelKey: "chip generate image", promptKey: "suggest generate image" },
	{ labelKey: "chip create board", promptKey: "suggest create board" },
	{ labelKey: "chip draw diagram", promptKey: "suggest draw diagram" },
];

export function SuggestionChips({ onPick }: { onPick(prompt: string): void }): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const collapsed = DEFAULT_SUGGESTIONS;
	const items = expanded ? [...collapsed, ...EXTRA_SUGGESTIONS] : collapsed;
	return (
		<div className="sh-suggest">
			{items.map((s, i) => {
				const extra = i >= collapsed.length;
				const cls = extra
					? `sh-suggest-chip sh-suggest-chip--expand${expanded ? "" : " sh-suggest-chip--leaving"}`
					: "sh-suggest-chip";
				return (
					<button
						key={s.promptKey}
						type="button"
						className={cls}
						style={
							extra && expanded
								? { animationDelay: `${(i - collapsed.length) * 40}ms` }
								: undefined
						}
						onClick={() => onPick(t(s.promptKey))}
					>
						{t(s.labelKey)}
					</button>
				);
			})}
			<button
				type="button"
				className="sh-suggest-chip sh-suggest-chip--more"
				title={expanded ? t("collapse suggestions") : t("more suggestions")}
				aria-label={expanded ? t("collapse suggestions") : t("more suggestions")}
				onClick={() => setExpanded(e => !e)}
			>
				{expanded ? "✕" : "+"}
			</button>
		</div>
	);
}
