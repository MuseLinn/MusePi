import { GitFork } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";

/**
 * The boundary a `branch_summary` entry draws between inherited history and
 * this branch's own turns.
 *
 * The fork glyph leads the caption inside one group so the line reads as a
 * fork, not a bare rule: same artwork as the branch switcher's rows, same
 * tertiary ink as the label, and the label keeps its text and accessible name
 * (the glyph is presentational).
 */
export function BranchSummaryDivider({ summary }: { summary?: string }): ReactNode {
	const label = t("settings.branchSummary");
	return (
		<div className="tr-divider" title={summary} role="separator" aria-label={label}>
			<span className="tr-branch-summary-caption">
				<GitFork size={14} aria-hidden />
				<span>{label}</span>
			</span>
		</div>
	);
}
