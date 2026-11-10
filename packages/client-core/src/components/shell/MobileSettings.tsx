import { LogOut } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { isHarmonyShell } from "../../lib/capacitor";
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

const TABBAR_MATERIAL_KEY = "musepi-tabbar-material";
type TabBarMaterial = "0" | "1" | "2" | "3";

/** HarmonyOS 7 immersive light-sense lets the user trade material thickness
 *  for battery. Four stops, mirroring the system settings language. */
export function TabBarMaterialControl(): ReactNode {
	const [value, setValue] = useState<TabBarMaterial>(() => {
		const stored = localStorage.getItem(TABBAR_MATERIAL_KEY);
		return stored === "1" || stored === "2" || stored === "3" ? stored : "0";
	});
	useEffect(() => {
		localStorage.setItem(TABBAR_MATERIAL_KEY, value);
		try {
			window.harmonyNative?.setTabBarMaterial?.(Number(value));
		} catch {
			// bridge absent — desktop web has no native bar
		}
	}, [value]);

	return (
		<Segmented
			className="sh-mobile-material"
			ariaLabel={t("settings.tabBarMaterial")}
			value={value}
			// Ordered by thickness, richest → lightest, so the stops read as a
			// gradient instead of an arbitrary list.
			options={[
				{ value: "1", label: t("settings.materialRegular") },
				{ value: "0", label: t("settings.materialBalanced") },
				{ value: "2", label: t("settings.materialThin") },
				{ value: "3", label: t("settings.materialUltraThin") },
			]}
			onChange={next => setValue(next as TabBarMaterial)}
		/>
	);
}

/** Full-screen mobile settings. Controls reuse the same preferences and host
 *  store as the connect screen and desktop header. */
export function MobileSettings({
	client,
	currentLink = "",
	phase,
	onSwitchTo,
	onLeave,
}: {
	/** Absent on the connect screen: the settings tab then exposes appearance
	 * preferences only, with no live session or host to manage. */
	client?: SessionClient | null;
	currentLink?: string;
	phase?: ConnectionPhase;
	onSwitchTo?(link: string, name: string): void;
	onLeave?(): void;
}): ReactNode {
	return (
		<div className="sh-mobile-settings">
			<header className="sh-mobile-settings-head">
				<h2>{t("settings.settings")}</h2>
			</header>

			<section className="sh-mobile-settings-section" aria-labelledby="mobile-appearance-title">
				<h3 id="mobile-appearance-title">{t("settings.appearance")}</h3>
				<div className="sh-setting-group">
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
					{isHarmonyShell() && (
						<div className="sh-mobile-setting-row sh-mobile-setting-row--stack">
							<span>
								{t("settings.tabBarMaterial")}
								<small className="sh-setting-hint">{t("settings.materialHint")}</small>
							</span>
							<TabBarMaterialControl />
						</div>
					)}
				</div>
			</section>

			{client && phase && onSwitchTo && onLeave && (
				<section className="sh-mobile-settings-section" aria-labelledby="mobile-hosts-title">
					<h3 id="mobile-hosts-title">{t("settings.manageHosts")}</h3>
					<HostManager currentLink={currentLink} phase={phase} onSwitchTo={onSwitchTo} onLeave={onLeave} />
				</section>
			)}

			{client && (
				<section className="sh-mobile-settings-section sh-mobile-settings-voice">
					<VoicePanel client={client} />
				</section>
			)}

			{onLeave && (
				<button type="button" className="sh-mobile-disconnect" onClick={onLeave}>
					<LogOut size={17} aria-hidden />
					<span>{t("settings.disconnect2")}</span>
				</button>
			)}
		</div>
	);
}
