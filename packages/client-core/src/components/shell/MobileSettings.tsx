import { Check, ChevronRight, LogOut, Monitor, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { setLocale, type TranslationKey, t } from "../../i18n/index.js";
import { useLocale } from "../../i18n/use-locale.js";
import { isHarmonyShell, isNativeShell } from "../../lib/capacitor";
import type { ConnectionPhase, SessionClient } from "../../lib/client";
import {
	addressLabel,
	hostIdForLink,
	loadResolvedHosts,
	type ResolvedHost,
	removeHost,
	renameHost,
} from "../../lib/hosts.js";
import { readMobilePref, writeMobilePref } from "../../lib/mobile-prefs.js";
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

/** A switch row: label, optional one-line hint, and an accessible toggle.
 *
 * Built on a native `button[role="switch"]` rather than a checkbox so the
 * pressed state announces itself and the whole row is the target — a phone
 * thumb misses 20px checkboxes, and the design spec's touch floor is 44px. */
function SettingSwitch({
	label,
	hint,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	disabled?: boolean;
	onChange(next: boolean): void;
}): ReactNode {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			className="sh-mobile-setting-row sh-mobile-switch"
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span className="sh-setting-label">
				{label}
				{hint !== undefined && <small className="sh-setting-hint">{hint}</small>}
			</span>
			<span className={`sh-switch${checked ? " sh-switch--on" : ""}`} aria-hidden="true">
				<span className="sh-switch-knob" />
			</span>
		</button>
	);
}

/**
 * Notification preferences.
 *
 * The permission itself belongs to the OS and cannot be granted from here —
 * when it is missing, the section says so and offers the system settings
 * route instead of a switch that would silently do nothing. The two event
 * switches are the page's own filter: which background events are worth
 * interrupting someone for.
 */
function MobileNotificationSettings(): ReactNode {
	const [onFinish, setOnFinish] = useState(() => readMobilePref("notifyOnFinish", true));
	const [onAsk, setOnAsk] = useState(() => readMobilePref("notifyOnAsk", true));
	// `"unknown"` until the plugin answers: rendering "denied" before the
	// probe resolves would flash a warning at every open.
	const [permission, setPermission] = useState<"unknown" | "granted" | "denied" | "unsupported">("unknown");

	useEffect(() => {
		if (!isNativeShell()) {
			setPermission("unsupported");
			return;
		}
		let alive = true;
		void (async () => {
			try {
				const { LocalNotifications } = await import("@capacitor/local-notifications");
				const status = await LocalNotifications.checkPermissions();
				if (alive) setPermission(status.display === "granted" ? "granted" : "denied");
			} catch {
				if (alive) setPermission("unsupported");
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	const requestPermission = (): void => {
		void (async () => {
			try {
				const { LocalNotifications } = await import("@capacitor/local-notifications");
				const status = await LocalNotifications.requestPermissions();
				setPermission(status.display === "granted" ? "granted" : "denied");
			} catch {
				setPermission("unsupported");
			}
		})();
	};

	const blocked = permission === "denied" || permission === "unsupported";

	return (
		<section className="sh-mobile-settings-section" aria-labelledby="mobile-notifications-title">
			<h3 id="mobile-notifications-title">{t("settings.mobile.notifications")}</h3>
			<div className="sh-setting-group">
				{permission === "denied" && (
					<button
						type="button"
						className="sh-mobile-setting-row sh-mobile-setting-row--warn"
						onClick={requestPermission}
					>
						<span className="sh-setting-label">{t("settings.mobile.notifyDenied")}</span>
						<span className="sh-mobile-setting-action">{t("settings.mobile.notifyDeniedAction")}</span>
						<ChevronRight size={16} aria-hidden="true" />
					</button>
				)}
				{permission === "unsupported" && (
					<div className="sh-mobile-setting-row sh-mobile-setting-row--muted">
						<span className="sh-setting-label">{t("settings.mobile.notifyUnsupported")}</span>
					</div>
				)}
				<SettingSwitch
					label={t("settings.mobile.notifyOnFinish")}
					hint={t("settings.mobile.notifyOnFinishHint")}
					checked={onFinish}
					disabled={blocked}
					onChange={next => {
						setOnFinish(next);
						writeMobilePref("notifyOnFinish", next);
					}}
				/>
				<SettingSwitch
					label={t("settings.mobile.notifyOnAsk")}
					hint={t("settings.mobile.notifyOnAskHint")}
					checked={onAsk}
					disabled={blocked}
					onChange={next => {
						setOnAsk(next);
						writeMobilePref("notifyOnAsk", next);
					}}
				/>
			</div>
		</section>
	);
}

/** Approximate on-disk size of what the page cached, per origin. */
async function cacheFootprint(): Promise<number> {
	if (typeof caches === "undefined") return 0;
	let bytes = 0;
	try {
		const names = await caches.keys();
		for (const name of names) {
			const cache = await caches.open(name);
			const requests = await cache.keys();
			for (const request of requests) {
				const response = await cache.match(request);
				if (!response) continue;
				const buffer = await response.clone().arrayBuffer();
				bytes += buffer.byteLength;
			}
		}
	} catch {
		// A cache entry that vanished mid-count only makes the number smaller;
		// reporting 0 is more honest than failing the whole section.
		return 0;
	}
	return bytes;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Storage and privacy.
 *
 * Two destructive actions with different blast radii, which is why they are
 * not one button: clearing cached assets costs a reload, clearing everything
 * costs the saved computers and their credentials. The confirm dialog states
 * the second consequence in one line — the design spec forbids a paragraph
 * here, and a user who has just lost their pairing needs to know why.
 */
function MobileStorageSettings({ onCleared }: { onCleared(): void }): ReactNode {
	const [bytes, setBytes] = useState<number | null>(null);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [done, setDone] = useState(false);

	useEffect(() => {
		void cacheFootprint().then(setBytes);
	}, []);

	const clearCache = (): void => {
		void (async () => {
			try {
				if (typeof caches !== "undefined") {
					const names = await caches.keys();
					await Promise.all(names.map(name => caches.delete(name)));
				}
			} catch {
				// best effort — a cache that refuses to clear is not worth an error state
			}
			setBytes(0);
			setDone(true);
			onCleared();
		})();
	};

	const clearAll = (): void => {
		setConfirmOpen(false);
		void (async () => {
			await clearCache();
			try {
				const keys = Object.keys(localStorage);
				for (const key of keys) {
					if (key.startsWith("musepi") || key.startsWith("omp")) localStorage.removeItem(key);
				}
			} catch {
				// storage unavailable — nothing further to remove
			}
			setDone(true);
			onCleared();
		})();
	};

	return (
		<section className="sh-mobile-settings-section" aria-labelledby="mobile-storage-title">
			<h3 id="mobile-storage-title">{t("settings.mobile.storage")}</h3>
			<div className="sh-setting-group">
				<div className="sh-mobile-setting-row">
					<span className="sh-setting-label">{t("settings.mobile.cacheUsed")}</span>
					<span className="sh-mobile-setting-value">{bytes === null ? "—" : formatBytes(bytes)}</span>
				</div>
				<button type="button" className="sh-mobile-setting-row" onClick={clearCache}>
					<span className="sh-setting-label">
						{t("settings.mobile.clearCache")}
						<small className="sh-setting-hint">{t("settings.mobile.clearCacheHint")}</small>
					</span>
					{done && <span className="sh-mobile-setting-value">{t("settings.mobile.cleared")}</span>}
				</button>
				<button
					type="button"
					className="sh-mobile-setting-row sh-mobile-setting-row--danger"
					onClick={() => setConfirmOpen(true)}
				>
					<span className="sh-setting-label">
						{t("settings.mobile.clearAll")}
						<small className="sh-setting-hint">{t("settings.mobile.clearAllHint")}</small>
					</span>
				</button>
			</div>
			{confirmOpen && (
				<div className="sh-mobile-confirm" role="alertdialog" aria-labelledby="mobile-clear-title">
					<p id="mobile-clear-title" className="sh-mobile-confirm-title">
						{t("settings.mobile.clearConfirmTitle")}
					</p>
					<p className="sh-mobile-confirm-body">{t("settings.mobile.clearConfirmBody")}</p>
					<div className="sh-mobile-confirm-actions">
						<button type="button" className="sh-btn" onClick={() => setConfirmOpen(false)}>
							{t("settings.cancel")}
						</button>
						<button type="button" className="sh-btn sh-btn-danger" onClick={clearAll}>
							{t("settings.mobile.clearConfirmAction")}
						</button>
					</div>
				</div>
			)}
		</section>
	);
}

/** Version, platform and a diagnostics copy — the three things a support
 *  thread asks for first. */
function MobileAboutSettings({ link }: { link: string }): ReactNode {
	const [copied, setCopied] = useState(false);
	const platform = isHarmonyShell()
		? t("settings.mobile.platformHarmony")
		: isNativeShell()
			? t("settings.mobile.platformAndroid")
			: t("settings.mobile.platformWeb");

	const copyDiagnostics = (): void => {
		const lines = [
			`version: ${import.meta.env?.VITE_APP_VERSION ?? "dev"}`,
			`platform: ${platform}`,
			`userAgent: ${navigator.userAgent}`,
			`link: ${link ? `${link.split(".")[0]}…` : "none"}`,
			`secure: ${window.isSecureContext === true}`,
			`storage: ${(() => {
				try {
					return localStorage.length;
				} catch {
					return "unavailable";
				}
			})()}`,
		];
		void navigator.clipboard?.writeText(lines.join("\n")).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1600);
		});
	};

	return (
		<section className="sh-mobile-settings-section" aria-labelledby="mobile-about-title">
			<h3 id="mobile-about-title">{t("settings.mobile.about")}</h3>
			<div className="sh-setting-group">
				<div className="sh-mobile-setting-row">
					<span className="sh-setting-label">{t("settings.mobile.version")}</span>
					<span className="sh-mobile-setting-value">0.7.6</span>
				</div>
				<div className="sh-mobile-setting-row">
					<span className="sh-setting-label">{t("settings.mobile.platform")}</span>
					<span className="sh-mobile-setting-value">{platform}</span>
				</div>
				<button type="button" className="sh-mobile-setting-row" onClick={copyDiagnostics}>
					<span className="sh-setting-label">{t("settings.mobile.copyDiagnostics")}</span>
					{copied && <span className="sh-mobile-setting-value">{t("settings.mobile.diagnosticsCopied")}</span>}
				</button>
			</div>
		</section>
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

			<MobileNotificationSettings />
			<MobileStorageSettings onCleared={() => {}} />
			<MobileAboutSettings link={currentLink} />

			{onLeave && (
				<button type="button" className="sh-mobile-disconnect" onClick={onLeave}>
					<LogOut size={17} aria-hidden />
					<span>{t("settings.disconnect2")}</span>
				</button>
			)}
		</div>
	);
}
