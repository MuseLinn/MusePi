import { LogOut } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import type { ConnectionPhase, SessionClient } from "../../lib/client";
import { VoicePanel } from "../panels/VoicePanel";
import { AccentToggle } from "./AccentToggle";
import { HostManager } from "./HostManager";
import { LanguageToggle } from "./LanguageToggle";
import { Segmented } from "./Segmented";
import { ThemeToggle } from "./ThemeToggle";

const INTERFACE_FONT_SCALE_KEY = "musepi-gui-font-scale";
type InterfaceFontScale = "13" | "15" | "17";

function storedInterfaceFontScale(): InterfaceFontScale {
	const stored = localStorage.getItem(INTERFACE_FONT_SCALE_KEY);
	return stored === "13" || stored === "17" ? stored : "15";
}

/** Mobile uses three readable stops but shares the desktop preference key and
 * CSS variable, so remote and desktop typography cannot drift apart. */
export function InterfaceFontSizeControl(): ReactNode {
	const [value, setValue] = useState<InterfaceFontScale>(storedInterfaceFontScale);
	useEffect(() => {
		document.documentElement.style.setProperty("--gui-font-scale", `${value}px`);
		localStorage.setItem(INTERFACE_FONT_SCALE_KEY, value);
	}, [value]);

	return (
		<Segmented
			className="sh-mobile-font-size"
			ariaLabel={t("settings.interfaceFontSize")}
			value={value}
			options={[
				{ value: "13", label: t("settings.fontSizeSmall") },
				{ value: "15", label: t("settings.fontSizeDefault") },
				{ value: "17", label: t("settings.fontSizeLarge") },
			]}
			onChange={next => setValue(next as InterfaceFontScale)}
		/>
	);
}

/** Full-screen mobile settings. Controls reuse the same preferences and host
 *  store as the connect screen and desktop header. */
export function MobileSettings({
	client,
	currentLink,
	phase,
	onSwitchTo,
	onLeave,
}: {
	client: SessionClient;
	currentLink: string;
	phase: ConnectionPhase;
	onSwitchTo(link: string, name: string): void;
	onLeave(): void;
}): ReactNode {
	return (
		<div className="sh-mobile-settings">
			<header className="sh-mobile-settings-head">
				<h2>{t("settings.settings")}</h2>
				<p>{t("settings.mobileSettingsBody")}</p>
			</header>

			<section className="sh-mobile-settings-section" aria-labelledby="mobile-appearance-title">
				<h3 id="mobile-appearance-title">{t("settings.appearance")}</h3>
				<div className="sh-mobile-setting-row">
					<span>{t("settings.theme")}</span>
					<ThemeToggle />
				</div>
				<div className="sh-mobile-setting-row">
					<span>{t("settings.accent")}</span>
					<AccentToggle />
				</div>
				<div className="sh-mobile-setting-row sh-mobile-setting-row--stack">
					<span>{t("settings.interfaceFontSize")}</span>
					<InterfaceFontSizeControl />
				</div>
				<div className="sh-mobile-setting-row">
					<span>{t("settings.language")}</span>
					<LanguageToggle />
				</div>
			</section>

			<section className="sh-mobile-settings-section" aria-labelledby="mobile-hosts-title">
				<h3 id="mobile-hosts-title">{t("settings.manageHosts")}</h3>
				<p className="sh-mobile-setting-description">{t("settings.mobileHostsBody")}</p>
				<HostManager currentLink={currentLink} phase={phase} onSwitchTo={onSwitchTo} onLeave={onLeave} />
			</section>

			<section className="sh-mobile-settings-section sh-mobile-settings-voice">
				<VoicePanel client={client} />
			</section>

			<button type="button" className="sh-mobile-disconnect" onClick={onLeave}>
				<LogOut size={17} aria-hidden />
				<span>{t("settings.disconnect2")}</span>
			</button>
		</div>
	);
}
