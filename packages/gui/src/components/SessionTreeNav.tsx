import { t } from "@musepi/desktop-web";
import { ChevronRight, GitFork } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Layer-1 session-tree navigation chrome (chat ↔ canvas unification):
 * the composer-adjacent breadcrumb + historical-node send hint.
 *
 * Breadcrumb: root → current-leaf path summary; every segment jumps the
 * transcript to that message (onJump). When the active leaf is a
 * historical node (has children), a hint above the composer states that
 * sending now forks a new branch ("将从「X」创建新分支").
 */
export interface BreadcrumbSegment {
	id: string;
	label: string;
	kind: "user" | "assistant" | "toolResult";
}

export function SessionTreeNav({
	segments,
	activeLeafIsHistorical,
	activeLeafLabel,
	onJump,
}: {
	/** Root → leaf path, oldest first. Empty = nothing to show. */
	segments: BreadcrumbSegment[];
	/** True when the current leaf already has children — sending forks. */
	activeLeafIsHistorical: boolean;
	/** Label of the active leaf (for the fork hint). */
	activeLeafLabel: string;
	onJump(entryId: string): void;
}): ReactNode {
	if (segments.length === 0) return null;
	// Cap the breadcrumb at 5 segments with an ellipsis (deep chains).
	const capped = segments.length > 5 ? segments.slice(-5) : segments;
	return (
		<div className="tr-tree-nav" data-testid="session-tree-nav">
			{activeLeafIsHistorical && (
				<div className="tr-tree-nav-hint" role="status">
					<GitFork size={12} />
					<span>
						{t("will fork a new branch from {label}", {
							label: activeLeafLabel || t("this node"),
						})}
					</span>
				</div>
			)}
			<div className="tr-tree-nav-breadcrumb" aria-label={t("session path")}>
				{segments.length > 5 && (
					<span className="tr-tree-nav-more" aria-hidden>
						…
					</span>
				)}
				{capped.map((seg, i) => (
					<span key={seg.id} className="tr-tree-nav-crumb">
						{i > 0 && <ChevronRight size={11} className="tr-tree-nav-sep" aria-hidden />}
						<button
							type="button"
							className={`tr-tree-nav-seg tr-tree-nav-seg--${seg.kind}`}
							title={seg.label}
							onClick={() => onJump(seg.id)}
						>
							{seg.label || "…"}
						</button>
					</span>
				))}
			</div>
		</div>
	);
}
