import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";

/** Quiet mobile draft state. The composer remains the primary action. */
function greeting(hour: number): string {
	if (hour < 5) return t("settings.lateTakeCare");
	if (hour < 8) return t("settings.earlyMorning");
	if (hour < 12) return t("settings.goodMorning");
	if (hour < 14) return t("settings.goodNoon");
	if (hour < 18) return t("settings.goodAfternoon");
	if (hour < 22) return t("settings.goodEvening");
	return t("settings.lateTakeCare");
}

export function WelcomeHint(): ReactNode {
	return (
		<div className="sh-welcome-hint">
			<p className="sh-welcome-greeting">{greeting(new Date().getHours())}</p>
			<p className="sh-welcome-tip">{t("composer.askAnythingCommands.info")}</p>
		</div>
	);
}
