import { t } from "@musepi/desktop-web";
import { ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { haptic } from "../lib/haptic";
import { sfxFor } from "../lib/sfx";
import { BorderBeam } from "../vendor/border-beam";

/**
 * Inline approval card (prototype §6.3) — rendered above the composer when a
 * tool call is paused awaiting a decision. Approve/deny calls
 * tool.approve / tool.deny on the daemon, which resolves the paused
 * ExtensionUIContext.select in the agent runtime.
 *
 * Pending state carries a pulse border beam + a soft chime so an
 * incoming approval interrupts without a modal.
 */
export function ApprovalCard({
	requestId,
	tool,
	onDecide,
}: {
	requestId: string;
	tool: string;
	onDecide(requestId: string, approved: boolean): void;
}): ReactNode {
	// Notify once per pending card (browser blocks audio before a gesture).
	// requestId is the per-card identity — the effect must re-run when the
	// card swaps even though the body doesn't read it.
	useEffect(() => {
		sfxFor("approval");
	}, [requestId]);
	return (
		<div className="gui-approval-wrap">
			<BorderBeam size="pulse-inner" colorVariant="ocean" theme="auto" borderRadius={14}>
				<div className="gui-approval" role="alert">
					<ShieldAlert size={14} className="gui-approval-icon" />
					<div className="gui-approval-body">
						<span className="gui-approval-title">{t("Approval required")}</span>
						<span className="gui-approval-tool">{tool}</span>
					</div>
					<div className="gui-approval-actions">
						<button
							type="button"
							className="gui-btn gui-btn-approve"
							onClick={() => {
								sfxFor("approval-ok");
								haptic(1);
								onDecide(requestId, true);
							}}
						>
							{t("Approve")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-stop"
							onClick={() => {
								sfxFor("approval-deny");
								haptic(2);
								onDecide(requestId, false);
							}}
						>
							{t("Deny")}
						</button>
					</div>
				</div>
			</BorderBeam>
		</div>
	);
}
