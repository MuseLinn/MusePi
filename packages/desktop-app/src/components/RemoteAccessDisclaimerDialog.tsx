import { type TranslationKey, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";
import { FadeScroll } from "./FadeScroll";

const CORE_RISKS: TranslationKey[] = [
	"settings.remoteDisclaimerRiskControl",
	"settings.remoteDisclaimerRiskLinks",
	"settings.remoteDisclaimerRiskNetwork",
	"settings.remoteDisclaimerRiskData",
];
const DETAILED_RISKS: TranslationKey[] = [
	"settings.remoteDisclaimerDetailInstances",
	"settings.remoteDisclaimerDetailPairing",
	"settings.remoteDisclaimerDetailThirdParty",
	"settings.remoteDisclaimerDetailCompliance",
];

export function RemoteAccessDisclaimerDialog({
	open,
	consented,
	onAgree,
	onDecline,
	onClose,
}: {
	open: boolean;
	consented: boolean;
	onAgree(): void;
	onDecline(): void;
	onClose(): void;
}): ReactNode {
	return (
		<DialogFrame
			open={open}
			onClose={onClose}
			label={t("settings.remoteDisclaimerTitle")}
			className="gui-remote-disclaimer-dialog"
		>
			<div className="gui-dialog-head">
				<h1 className="gui-remote-disclaimer-title">{t("settings.remoteDisclaimerTitle")}</h1>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("settings.close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<FadeScroll className="gui-remote-disclaimer-body">
				<span
					className={`gui-remote-disclaimer-status${consented ? " gui-remote-disclaimer-status--accepted" : ""}`}
				>
					{consented ? t("settings.remoteDisclaimerAccepted") : t("settings.remoteDisclaimerNotAccepted")}
				</span>
				<p className="gui-remote-disclaimer-intro">{t("settings.remoteDisclaimerIntro")}</p>
				<h2 className="gui-remote-disclaimer-heading">{t("settings.remoteDisclaimerCoreTitle")}</h2>
				<ol className="gui-remote-disclaimer-risks">
					{CORE_RISKS.map(key => (
						<li key={key}>{t(key)}</li>
					))}
				</ol>
				<details className="gui-remote-disclaimer-details">
					<summary>{t("settings.remoteDisclaimerDetailsSummary")}</summary>
					<ol className="gui-remote-disclaimer-risks" start={CORE_RISKS.length + 1}>
						{DETAILED_RISKS.map(key => (
							<li key={key}>{t(key)}</li>
						))}
					</ol>
				</details>
			</FadeScroll>
			<div className="gui-remote-disclaimer-actions">
				{consented ? (
					<button type="button" className="gui-btn gui-btn-primary" onClick={onClose}>
						{t("settings.close")}
					</button>
				) : (
					<>
						<button type="button" className="gui-btn" onClick={onDecline}>
							{t("settings.remoteDisclaimerDecline")}
						</button>
						<button type="button" className="gui-btn gui-btn-primary" onClick={onAgree}>
							{t("settings.remoteDisclaimerAgree")}
						</button>
					</>
				)}
			</div>
		</DialogFrame>
	);
}
