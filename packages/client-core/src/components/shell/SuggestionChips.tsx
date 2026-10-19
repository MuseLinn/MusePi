import type { ReactNode } from "react";
import { useState } from "react";
import { type TranslationKey, t } from "../../i18n/index.js";

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
	{ labelKey: "general.chipExploreCodebase", promptKey: "general.suggestExploreCodebase" },
	{ labelKey: "general.chipCatchMeUp", promptKey: "general.suggestCatchMeUp" },
	{ labelKey: "general.chipWeighOptions", promptKey: "general.suggestWeighOptions" },
	{ labelKey: "general.chipStartFeaturePlanning", promptKey: "general.suggestStartFeaturePlanning" },
	{ labelKey: "general.chipCreateGoal", promptKey: "general.suggestCreateGoal" },
	{ labelKey: "general.chipScheduleTask", promptKey: "general.suggestScheduleTask" },
	{ labelKey: "general.chipDebugIssue", promptKey: "general.suggestDebugIssue" },
	{ labelKey: "general.chipReviewChanges", promptKey: "general.suggestReviewChanges" },
];

/** Extra suggestions revealed by the `+` expansion. */
const EXTRA_SUGGESTIONS: SuggestionDef[] = [
	{ labelKey: "general.chipWriteTests", promptKey: "general.suggestWriteTests" },
	{ labelKey: "general.chipRefactor", promptKey: "general.suggestRefactor" },
	{ labelKey: "general.chipPerformance", promptKey: "general.suggestPerformance" },
	{ labelKey: "general.chipWebSearch", promptKey: "general.suggestWebSearch" },
	{ labelKey: "general.chipGenerateImage", promptKey: "general.suggestGenerateImage" },
	{ labelKey: "general.chipCreateBoard", promptKey: "general.suggestCreateBoard" },
	{ labelKey: "general.chipDrawDiagram", promptKey: "general.suggestDrawDiagram" },
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
						style={extra && expanded ? { animationDelay: `${(i - collapsed.length) * 40}ms` } : undefined}
						onClick={() => onPick(t(s.promptKey))}
					>
						{t(s.labelKey)}
					</button>
				);
			})}
			<button
				type="button"
				className="sh-suggest-chip sh-suggest-chip--more"
				title={expanded ? t("general.collapseSuggestions") : t("general.moreSuggestions")}
				aria-label={expanded ? t("general.collapseSuggestions") : t("general.moreSuggestions")}
				onClick={() => setExpanded(e => !e)}
			>
				{expanded ? "✕" : "+"}
			</button>
		</div>
	);
}
