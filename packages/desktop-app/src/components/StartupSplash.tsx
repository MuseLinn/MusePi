import { BlurText, t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { SplashOrb } from "./SplashOrb";

export function StartupSplash(): ReactNode {
	return (
		<div className="gui-splash">
			<div className="gui-splash-inner">
				<div className="gui-splash-orb">
					<SplashOrb />
				</div>
				<BlurText text="MusePi" className="gui-splash-wordmark" stepMs={55} />
				<div className="gui-splash-progress-track" aria-hidden="true">
					<span className="gui-splash-progress-fill" />
				</div>
				<progress className="gui-splash-progress-native" aria-label={t("settings.loading")} />
			</div>
		</div>
	);
}
