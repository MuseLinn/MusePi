import { type TranslationKey, t } from "@musepi/desktop-web";
import type { SoundName } from "cuelume";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
	defaultTemplate,
	eventEnabled,
	loadNotifyTemplates,
	NOTIFY_EVENTS,
	type NotifyEvent,
	type NotifyTemplates,
	notifyEnabled,
	notifyWhileFocused,
	saveEventPrefs,
	saveNotifyTemplates,
	sendTestNotification,
} from "../../lib/notify";
import type { RpcClient } from "../../lib/rpc";
import {
	ALL_SOUNDS,
	DEFAULT_SFX,
	previewSound,
	SFX_EVENTS,
	type SfxEvent,
	setSoundFor,
	soundFor,
	WIRED_SOUNDS,
} from "../../lib/sfx";
import { Icon } from "../../vendor/oc-icons";
import { GuiSelect } from "../GuiSelect";
import { Reveal } from "../Reveal";

/** Wired sound → trigger description (i18n keys); see sfx.ts WIRED_SOUNDS. */
const SOUND_USAGE_KEYS: Partial<Record<SoundName, TranslationKey>> = {
	chime: "send message, approval request",
	sparkle: "first message, prompt enhanced",
	error: "connect error, approval denied",
	page: "session switch",
	release: "stop current turn",
	success: "approval granted",
	tick: "tool result arrived",
};

/** One configurable activity row (opencode per-category sounds parity):
 *  activity name + trigger desc, a preview button for the current choice,
 *  and a palette select that persists under musepi-gui-sfx:<event>. */
export function SoundEventRow({ ev }: { ev: SfxEvent }): ReactNode {
	const [name, setName] = useState<SoundName>(() => soundFor(ev));
	return (
		<div className="gui-sfx-event-row">
			<div className="min-w-0 flex-1">
				<div className="gui-settings-row-label">{t(`sfx event ${ev}`)}</div>
				<div className="gui-settings-row-desc">
					{t(`sfx event ${ev} desc`)} · {t("default")}: {DEFAULT_SFX[ev]}
				</div>
			</div>
			<button
				type="button"
				className="gui-sfx-preview"
				onClick={() => previewSound(name)}
				aria-label={`${t("preview")} ${name}`}
				title={`${t("preview")} ${name}`}
			>
				<Icon name="play" className="h-3.5 w-3.5" />
			</button>
			<GuiSelect
				className="gui-settings-select"
				value={name}
				onChange={v => {
					const next = v as SoundName;
					setName(next);
					setSoundFor(ev, next);
				}}
				ariaLabel={t(`sfx event ${ev}`)}
				options={ALL_SOUNDS.map(s => ({ value: s, label: s }))}
			/>
		</div>
	);
}

/** Notification template variables (openchamber parity). */
const TEMPLATE_VARIABLES = [
	"project_name",
	"worktree",
	"branch",
	"session_name",
	"agent_name",
	"model_name",
	"last_message",
] as const;

/** Desktop notifications + sound — openchamber parity: a delivery switch
 * (master + focused mode), four event toggles (completion / subtask /
 * error / question), per-event title/message templates with {variable}
 * substitution, and the sound palette below. All prefs are renderer-local. */
export function NotificationsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [notify, setNotify] = useState<boolean>(() => notifyEnabled());
	const [focused, setFocused] = useState<boolean>(() => notifyWhileFocused());
	const [eventPrefs, setEventPrefs] = useState<Record<NotifyEvent, boolean>>(() => {
		const out = {} as Record<NotifyEvent, boolean>;
		for (const ev of NOTIFY_EVENTS) out[ev] = eventEnabled(ev);
		return out;
	});
	const [templates, setTemplates] = useState<NotifyTemplates>(() => loadNotifyTemplates());
	const [sound, setSound] = useState<boolean>(() => localStorage.getItem("musepi-gui-sound") !== "0");
	const [hapticOn, setHapticOn] = useState<boolean>(() => localStorage.getItem("musepi-gui-haptic") !== "0");
	const [testResult, setTestResult] = useState<{ ok: boolean; reason?: string } | null>(null);
	// Idle recap (daemon recap.enabled / recap.idleSeconds — TUI parity).
	// Daemon-side settings (config.yml), unlike the renderer-local prefs
	// above; null = still loading.
	const [recapEnabled, setRecapEnabled] = useState<boolean | null>(null);
	const [recapIdleSeconds, setRecapIdleSeconds] = useState<number>(240);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<Record<string, unknown>>("settings.get", { keys: ["recap.enabled", "recap.idleSeconds"] })
			.then(res => {
				if (!alive) return;
				if (typeof res?.["recap.enabled"] === "boolean") setRecapEnabled(res["recap.enabled"]);
				if (typeof res?.["recap.idleSeconds"] === "number") setRecapIdleSeconds(res["recap.idleSeconds"]);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);
	return (
		<>
			<h2 className="gui-settings-page-title">{t("notifications & sound")}</h2>
			<p className="gui-settings-page-desc">{t("notifications settings")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("notification delivery")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("enable notifications")}</div>
						<div className="gui-settings-row-desc">{t("enable notifications description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={notify}
						className={`gui-toggle${notify ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !notify;
							setNotify(next);
							localStorage.setItem("musepi-gui-notify", next ? "1" : "0");
						}}
						aria-label={t("enable notifications")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={notify}>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("notify when focused")}</div>
							<div className="gui-settings-row-desc">{t("notify when focused description")}</div>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={focused}
							className={`gui-toggle${focused ? " gui-toggle--on" : ""}`}
							onClick={() => {
								const next = !focused;
								setFocused(next);
								localStorage.setItem("musepi-gui-notify-focused", next ? "1" : "0");
							}}
							aria-label={t("notify when focused")}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("send test notification")}</div>
							<div className="gui-settings-row-desc">{t("send test notification description")}</div>
						</div>
						<button
							type="button"
							className="gui-btn"
							onClick={async () => {
								setTestResult(null);
								const result = await sendTestNotification();
								setTestResult(result);
							}}
						>
							<Icon name="notification-3" className="h-3.5 w-3.5" />
							{t("send test notification")}
						</button>
						{testResult && (
							<p
								className={
									testResult.ok
										? "text-[13px] text-[var(--color-ok)]"
										: "text-[13px] text-[var(--color-error)]"
								}
							>
								{testResult.ok ? t("notification sent") : (testResult.reason ?? t("delivery failed"))}
							</p>
						)}
					</div>
				</Reveal>
			</div>
			<Reveal open={notify}>
				<div className="gui-settings-section">
					<div className="gui-settings-section-title">{t("notification events")}</div>
					{NOTIFY_EVENTS.map(ev => (
						<div key={ev} className="gui-settings-row">
							<div className="gui-settings-row-label">{t(`notification event ${ev}`)}</div>
							<button
								type="button"
								role="switch"
								aria-checked={eventPrefs[ev]}
								className={`gui-toggle${eventPrefs[ev] ? " gui-toggle--on" : ""}`}
								onClick={() => {
									const next = { ...eventPrefs, [ev]: !eventPrefs[ev] };
									setEventPrefs(next);
									saveEventPrefs(next);
								}}
								aria-label={t(`notification event ${ev}`)}
							>
								<span className="gui-toggle-knob" />
							</button>
						</div>
					))}
				</div>
				<div className="gui-settings-section">
					<div className="gui-settings-section-title">{t("notification templates")}</div>
					<div className="gui-settings-row-desc">
						{t("template variables")}:{" "}
						{TEMPLATE_VARIABLES.map(v => (
							<code key={v} className="gui-tpl-var">{`{${v}}`}</code>
						))}
					</div>
					<div className="gui-notify-tpl-grid">
						{NOTIFY_EVENTS.map(ev => (
							<div key={ev} className="gui-notify-tpl-group">
								<div className="gui-notify-tpl-name">{t(`notification event ${ev}`)}</div>
								<div>
									<label className="gui-notify-tpl-label" htmlFor={`omp-tpl-${ev}-title`}>
										{t("title")}
									</label>
									<input
										id={`omp-tpl-${ev}-title`}
										className="gui-input"
										value={templates[ev].title}
										placeholder={defaultTemplate(ev, "title")}
										onChange={e => {
											const next = { ...templates, [ev]: { ...templates[ev], title: e.target.value } };
											setTemplates(next);
											saveNotifyTemplates(next);
										}}
									/>
								</div>
								<div>
									<label className="gui-notify-tpl-label" htmlFor={`omp-tpl-${ev}-message`}>
										{t("message")}
									</label>
									<input
										id={`omp-tpl-${ev}-message`}
										className="gui-input"
										value={templates[ev].message}
										placeholder={defaultTemplate(ev, "message")}
										onChange={e => {
											const next = { ...templates, [ev]: { ...templates[ev], message: e.target.value } };
											setTemplates(next);
											saveNotifyTemplates(next);
										}}
									/>
								</div>
							</div>
						))}
					</div>
				</div>
			</Reveal>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("sound effects")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("sound effects")}</div>
						<div className="gui-settings-row-desc">{t("send chime, tool clicks")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={sound}
						className={`gui-toggle${sound ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !sound;
							setSound(next);
							localStorage.setItem("musepi-gui-sound", next ? "1" : "0");
						}}
						aria-label={t("sound effects")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("haptic feedback")}</div>
						<div className="gui-settings-row-desc">{t("haptic feedback description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={hapticOn}
						className={`gui-toggle${hapticOn ? " gui-toggle--on" : ""}`}
						onClick={() => {
							const next = !hapticOn;
							setHapticOn(next);
							localStorage.setItem("musepi-gui-haptic", next ? "1" : "0");
						}}
						aria-label={t("haptic feedback")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row-desc">{t("sfx choose per activity")}</div>
				<Reveal open={sound}>
					<div className="gui-sfx-event-list">
						{SFX_EVENTS.map(ev => (
							<SoundEventRow key={ev} ev={ev} />
						))}
					</div>
				</Reveal>
				<div className="gui-settings-row-desc">
					{t("preview each effect; dimmed ones are not wired to the UI yet")}
				</div>
				<div className="gui-sound-grid">
					{ALL_SOUNDS.map(name => {
						const wired = WIRED_SOUNDS.has(name);
						return (
							<div key={name} className={`gui-sound-card${wired ? "" : " gui-sound-card--idle"}`}>
								<button
									type="button"
									className="gui-sound-preview"
									onClick={() => previewSound(name)}
									aria-label={`${t("preview")} ${name}`}
									title={`${t("preview")} ${name}`}
								>
									<Icon name="play" className="h-3.5 w-3.5" />
								</button>
								<div className="min-w-0">
									<div className="gui-sound-name">{name}</div>
									<div className="gui-sound-usage">
										{wired ? t(SOUND_USAGE_KEYS[name] ?? "sound palette") : t("not wired to the UI yet")}
									</div>
								</div>
							</div>
						);
					})}
				</div>
			</div>
			{/* Idle recap (TUI 通知组 parity): daemon-side, persisted to
			 * config.yml — the same recap.enabled / recap.idleSeconds keys
			 * the terminal uses. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("idle recap")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("Idle Recap")}</div>
						<div className="gui-settings-row-desc">
							{t("Generate a brief LLM recap of where things stand after the terminal has been idle")}
						</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={recapEnabled === true}
						className={`gui-toggle${recapEnabled === true ? " gui-toggle--on" : ""}`}
						disabled={recapEnabled === null}
						onClick={() => {
							const next = recapEnabled !== true;
							setRecapEnabled(next);
							if (rpc) {
								void rpc
									.request("settings.set", { key: "recap.enabled", value: next })
									.catch(() => setRecapEnabled(recapEnabled));
							}
						}}
						aria-label={t("Idle Recap")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={recapEnabled !== false}>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("Idle Recap Delay")}</div>
							<div className="gui-settings-row-desc">
								{t("Seconds to wait while idle before showing the recap")}
							</div>
						</div>
						<GuiSelect
							className="gui-settings-select"
							value={String(recapIdleSeconds)}
							onChange={v => {
								const next = Number(v);
								setRecapIdleSeconds(next);
								if (rpc) {
									void rpc.request("settings.set", { key: "recap.idleSeconds", value: next }).catch(() => {});
								}
							}}
							ariaLabel={t("Idle Recap Delay")}
							options={[60, 120, 240, 300, 600].map(seconds => ({
								value: String(seconds),
								label: t("idle recap delay option", { count: String(seconds / 60) }),
							}))}
						/>
					</div>
				</Reveal>
			</div>
		</>
	);
}
