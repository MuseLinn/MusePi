import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import type { ConnectionPhase } from "../../lib/client";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	onRejoin(): void;
	onNewLink(): void;
}

export function Banners({ phase, endedReason, onRejoin, onNewLink }: BannersProps): ReactNode {
	if (phase === "connecting" || phase === "waiting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{t(phase === "connecting" ? "shell.connectingRelay" : "shell.joiningSession")}
			</div>
		);
	}
	if (phase === "reconnecting") {
		return (
			<div className="sh-banner" role="status">
				<span className="sh-banner-dot" />
				{t("shell.reconnecting")}
			</div>
		);
	}
	if (phase === "ended") {
		return (
			<div className="sh-ended" role="alertdialog" aria-label={t("shell.sessionEnded")}>
				<div className="sh-ended-card">
					<div className="sh-ended-title">{t("shell.sessionEnded")}</div>
					{endedReason && <div className="sh-ended-reason">{endedReason}</div>}
					<div className="sh-ended-actions">
						<button type="button" className="sh-btn sh-btn-primary" onClick={onRejoin}>
							{t("settings.rejoin")}
						</button>
						<button type="button" className="sh-btn" onClick={onNewLink}>
							{t("shell.newLink")}
						</button>
					</div>
				</div>
			</div>
		);
	}
	return null;
}
