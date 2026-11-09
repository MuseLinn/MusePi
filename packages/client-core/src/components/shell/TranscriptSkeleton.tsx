import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";

/**
 * Loading placeholder for a session whose snapshot has not landed yet.
 *
 * Opening a session clears the transcript and rehydrates it; for that window
 * the row list is empty, which the empty-state greeting used to claim as
 * "this is a brand-new session" — a mobile-parity bug bitfun's session
 * lifecycle guidance calls out explicitly (an empty session is a successful
 * open, and the conversation view owns its loading state). The skeleton is
 * layout-only: it announces itself to assistive tech once, from the sibling
 * status line, and stays out of the way otherwise.
 */
export function TranscriptSkeleton(): ReactNode {
	return (
		<>
			<div className="sh-skeleton" aria-hidden="true">
				<span className="sh-skeleton-row sh-skeleton-row--lead" />
				<span className="sh-skeleton-row" />
				<span className="sh-skeleton-row sh-skeleton-row--short" />
				<span className="sh-skeleton-row sh-skeleton-row--block" />
				<span className="sh-skeleton-row" />
				<span className="sh-skeleton-row sh-skeleton-row--short" />
			</div>
			<span className="sh-skeleton-status" role="status">
				{t("transcript.loadingSession")}
			</span>
		</>
	);
}
