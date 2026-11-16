import { Check, LogOut, Monitor, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { setLocale, type TranslationKey, t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/use-locale.js";
import { isHarmonyShell } from "../../lib/capacitor";
import type { ConnectionPhase, SessionClient } from "../../lib/client";
import {
	addressLabel,
	hostIdForLink,
	loadResolvedHosts,
	type ResolvedHost,
	removeHost,
	renameHost,
} from "../../lib/hosts.js";
import { ACCENT_PRESETS, type AccentPreference, useAccentPreference } from "../../lib/theme.js";
import { VoicePanel } from "../panels/VoicePanel";
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

const ACCENT_LABEL: Record<Exclude<AccentPreference, "custom">, TranslationKey> = {
	theme: "settings.accentTheme",
	brand: "settings.accentBrand",
	mono: "settings.accentMono",
	ocean: "settings.accentOcean",
	jade: "settings.accentJade",
};

/**
 * Accent as a row of real swatches instead of a cycle button.
 *
 * The old control was one 40px dot that advanced to the next preset on tap:
 * it showed the *current* colour and hid the other four behind repeated
 * tapping, which is a guessing game on a phone. Each swatch renders inside its
 * own `data-accent` scope, so the preview IS the colour the tap will apply —
 * including the light-scheme variant the token file derives separately.
 */
function AccentSwatches(): ReactNode {
	const { accent, setAccent } = useAccentPreference();
	return (
		<div className="sh-accent-swatches" role="radiogroup" aria-label={t("settings.accent")}>
			{ACCENT_PRESETS.map(preset => {
				const label = t(ACCENT_LABEL[preset.id as Exclude<AccentPreference, "custom">]);
				const selected = accent === preset.id;
				return (
					<button
						key={preset.id}
						type="button"
						role="radio"
						aria-checked={selected}
						aria-label={label}
						title={label}
						className="sh-accent-swatch-btn"
						data-accent={preset.id}
						onClick={() => setAccent(preset.id)}
					>
						<span className="sh-accent-swatch" aria-hidden="true">
							{selected && <Check size={14} strokeWidth={3} className="sh-accent-swatch-check" />}
						</span>
					</button>
				);
			})}
		</div>
	);
}

/**
 * Language as a two-stop segmented control. The shared `LanguageToggle` is one
 * 40px button showing the *target* language next to a glyph; inside a settings
 * row that read as a cramped "文EN" badge and never said which language was
 * currently active.
 */
function MobileLanguageControl(): ReactNode {
	const locale = useLocale();
	const current = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
	return (
		<Segmented
			className="sh-mobile-language"
			ariaLabel={t("settings.language")}
			value={current}
			options={[
				{ value: "zh", label: t("settings.languageNameZh") },
				{ value: "en", label: t("settings.languageNameEn") },
			]}
			onChange={next => setLocale(next === "zh" ? "zh-CN" : "en-US")}
		/>
	);
}

/**
 * Saved computers, as an inline list.
 *
 * The old section reused the desktop `HostManager`, which needs a live
 * connection (`client`, `phase`) and opens a modal — so the one thing a user
 * wants after a failed connect ("which computers do I have, let me retry") was
 * the one thing the page refused to show. Everything here comes from the local
 * host store, so the list works offline, and connecting is just a callback.
 */
function MobileComputers({
	currentLink,
	onConnect,
	onLeave,
}: {
	currentLink: string;
	onConnect?(link: string, name: string): void;
	onLeave?(): void;
}): ReactNode {
	const [hosts, setHosts] = useState<ResolvedHost[] | null>(null);
	const [editing, setEditing] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const currentId = currentLink ? hostIdForLink(currentLink) : null;

	useEffect(() => {
		let alive = true;
		void loadResolvedHosts().then(next => {
			if (alive) setHosts(next);
		});
		return () => {
			alive = false;
		};
	}, []);

	const commit = async (host: ResolvedHost): Promise<void> => {
		const label = draft.trim();
		if (label !== "" && label !== host.label) {
			await renameHost(host.id, label);
			setHosts(current => current?.map(item => (item.id === host.id ? { ...item, label } : item)) ?? null);
		}
		setEditing(null);
	};

	const remove = async (host: ResolvedHost): Promise<void> => {
		setBusy(host.id);
		try {
			await removeHost(host.id);
			setHosts(current => current?.filter(item => item.id !== host.id) ?? null);
			if (host.id === currentId) onLeave?.();
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="sh-mobile-computers">
			{hosts === null && <div className="sh-mobile-computers-empty">{t("settings.savedHostsLoading")}</div>}
			{hosts?.length === 0 && <div className="sh-mobile-computers-empty">{t("settings.noSavedHostsYet")}</div>}
			{hosts?.map(host => {
				const isCurrent = host.id === currentId;
				const address = host.candidates[0]?.address ?? "";
				if (editing === host.id) {
					return (
						<form
							key={host.id}
							className="sh-mobile-computer sh-mobile-computer--edit"
							onSubmit={event => {
								event.preventDefault();
								void commit(host);
							}}
						>
							<input
								// Focus lands in the field because the row just became one.
								autoFocus
								className="sh-input"
								value={draft}
								onChange={event => setDraft(event.target.value)}
								onBlur={() => void commit(host)}
								maxLength={40}
								aria-label={t("settings.hostName")}
							/>
						</form>
					);
				}
				return (
					<div key={host.id} className="sh-mobile-computer">
						<button
							type="button"
							className="sh-mobile-computer-main"
							disabled={isCurrent || !onConnect}
							onClick={() => onConnect?.(host.link, host.deviceName)}
						>
							<span className="sh-mobile-computer-icon" aria-hidden="true">
								<Monitor size={17} />
							</span>
							<span className="sh-mobile-computer-copy">
								<span className="sh-mobile-computer-name">
									{host.label}
									{isCurrent && <span className="sh-mobile-computer-cur">{t("settings.current")}</span>}
								</span>
								{address !== "" && <span className="sh-mobile-computer-addr">{addressLabel(address)}</span>}
							</span>
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-mobile-computer-act"
							title={t("settings.rename")}
							aria-label={`${t("settings.rename")} ${host.label}`}
							onClick={() => {
								setDraft(host.label);
								setEditing(host.id);
							}}
						>
							<Pencil size={14} />
						</button>
						<button
							type="button"
							className="sh-btn sh-btn-icon sh-mobile-computer-act sh-mobile-computer-rm"
							title={t("settings.removeHost")}
							aria-label={`${t("settings.removeHost")} ${host.label}`}
							disabled={busy === host.id}
							onClick={() => void remove(host)}
						>
							<Trash2 size={14} />
						</button>
					</div>
				);
			})}
		</div>
	);
}

/** Full-screen mobile settings. Controls reuse the same preferences and host
 *  store as the connect screen and desktop header. */
export function MobileSettings({
	client,
	currentLink = "",
	phase,
	onSwitchTo,
	onConnectHost,
	onLeave,
}: {
	/** Absent on the connect screen: the settings tab then still manages saved
	 * computers (they live locally), but has no live session to talk to. */
	client?: SessionClient | null;
	currentLink?: string;
	phase?: ConnectionPhase;
	onSwitchTo?(link: string, name: string): void;
	/** Connect to a saved computer while nothing is connected. */
	onConnectHost?(link: string, name: string): void;
	onLeave?(): void;
}): ReactNode {
	return (
		<div className="sh-mobile-settings" role="region" aria-label={t("settings.settings")}>
			<section className="sh-mobile-settings-section" aria-labelledby="mobile-appearance-title">
				<h3 id="mobile-appearance-title">{t("settings.appearance")}</h3>
				<div className="sh-setting-group">
					<div className="sh-mobile-setting-row">
						<span className="sh-setting-label">{t("settings.theme")}</span>
						<ThemeToggle />
					</div>
					<div className="sh-mobile-setting-row sh-mobile-setting-row--stack">
						<span className="sh-setting-label">{t("settings.accent")}</span>
						<AccentSwatches />
					</div>
					<div className="sh-mobile-setting-row sh-mobile-setting-row--stack">
						<span className="sh-setting-label">{t("settings.interfaceFontSize")}</span>
						<InterfaceFontSizeControl />
					</div>
					<div className="sh-mobile-setting-row">
						<span className="sh-setting-label">{t("settings.language")}</span>
						<MobileLanguageControl />
					</div>
					{isHarmonyShell() && (
						<div className="sh-mobile-setting-row sh-mobile-setting-row--stack">
							<span className="sh-setting-label">
								{t("settings.tabBarMaterial")}
								<small className="sh-setting-hint">{t("settings.materialHint")}</small>
							</span>
							<TabBarMaterialControl />
						</div>
					)}
				</div>
			</section>

			{/* Saved computers are local, so this section never depends on a live
			 * session: the moment a user needs it most is right after a failed
			 * connect. It also replaces the header switcher on phones — one list,
			 * one place, whether or not anything is connected. */}
			<section className="sh-mobile-settings-section" aria-labelledby="mobile-hosts-title">
				<h3 id="mobile-hosts-title">
					{t("settings.manageHosts")}
					{phase === "live" || phase === "workspace" ? (
						<span className="sh-setting-section-note">{t("transcript.connected")}</span>
					) : null}
				</h3>
				<div className="sh-setting-group">
					<MobileComputers
						currentLink={currentLink}
						onConnect={client && onSwitchTo ? onSwitchTo : onConnectHost}
						onLeave={onLeave}
					/>
				</div>
			</section>

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
