import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import type { ConnectionPhase } from "../../lib/client";

export interface BannersProps {
	phase: ConnectionPhase;
	endedReason: string | null;
	onRejoin(): void;
	onNewLink(): void;
	/**
	 * Whether the ended state may take over the screen.
	 *
	 * The card is an `alertdialog` with no dismiss: correct over a transcript
	 * that just died, wrong over the settings tab, where it covered controls
	 * the user was using and offered two answers to a question they had not
	 * asked. Mobile passes `false` off the chat destination and gets a status
	 * line instead.
	 */
	blocking?: boolean;
}

export function Banners({ phase, endedReason, onRejoin, onNewLink, blocking = true }: BannersProps): ReactNode {
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
		if (!blocking) {
			return (
				<div className="sh-banner sh-banner--ended" role="status">
					<span className="sh-banner-dot" />
					<span className="sh-banner-text">
						{t("shell.sessionEnded")}
						{endedReason ? ` — ${endedReason}` : ""}
					</span>
					<button type="button" className="sh-banner-action" onClick={onRejoin}>
						{t("settings.rejoin")}
					</button>
				</div>
			);
		}
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
