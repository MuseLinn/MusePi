/**
 * Tool-approval card for the host view — renders a pending
 * `approval-request` with the action's prompt and approve/deny buttons. The
 * collab guest never sees approvals (host-side only), so this lives in the
 * host-mode render path.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { type SessionClient, useGuestSelector } from "../../lib/use-guest";

/** Renders the pending approval card, or null when none. */
export function ApprovalCard({ client }: { client: SessionClient }): ReactNode {
	const approval = useGuestSelector(client, s => s.approvalRequest);
	if (!approval) return null;

	return (
		<div className="sh-approval" role="alertdialog" aria-label={t("approval needed")}>
			<div className="sh-approval-title">{t("approval needed")}</div>
			<div className="sh-approval-tool">{approval.tool}</div>
			{approval.prompt && <pre className="sh-approval-prompt">{approval.prompt}</pre>}
			<div className="sh-approval-actions">
				<button
					type="button"
					className="sh-btn sh-btn-deny"
					onClick={() => client.respondApproval(approval.requestId, false)}
				>
					{t("deny tool")}
				</button>
				<button
					type="button"
					className="sh-btn sh-btn-approve"
					onClick={() => client.respondApproval(approval.requestId, true)}
				>
					{t("approve tool")}
				</button>
			</div>
			{/* Design doc §B2: while the card blocks the run it owns the wait
			 * feedback — a thin accent shuttle replaces the (now hidden)
			 * chat-level working pill, so "waiting on you" reads once. */}
			<div className="sh-approval-wait" aria-hidden="true">
				<span className="sh-approval-wait-label">{t("waiting for your decision")}</span>
				<span className="sh-approval-wait-track">
					<span className="sh-approval-wait-bar" />
				</span>
			</div>
		</div>
	);
}
