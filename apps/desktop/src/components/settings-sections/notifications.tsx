import { type TranslationKey, t } from "@musepi/client-core";
import type { SoundName } from "cuelume";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
	defaultTemplate,
	eventEnabled,
	inAppToastEnabled,
	loadNotifyTemplates,
	NOTIFY_EVENTS,
	type NotifyEvent,
	type NotifyTemplates,
	notifyEnabled,
	notifySfxEvent,
	notifySoundEnabled,
	notifyWhileFocused,
	saveEventPrefs,
	saveNotifyTemplates,
	sendTestNotification,
	setInAppToastEnabled,
	setNotifySoundEnabled,
} from "../../lib/notify";
import type { RpcClient } from "../../lib/rpc";
import {
	inQuietHours,
	previewSound,
	type QuietHours,
	quietHoursPref,
	SELECTABLE_SOUNDS,
	SFX_EVENTS,
	type SfxChoice,
	type SfxEvent,
	setQuietHoursPref,
	setSoundFor,
	setVolumePref,
	soundFor,
	volumePref,
} from "../../lib/sfx";
import { Icon } from "../../vendor/oc-icons";
import { GuiSelect } from "../GuiSelect";
import { Reveal } from "../Reveal";

/** Sfx/notification event labels are keyed per event id; the ids come from
 *  SFX_EVENTS / NOTIFY_EVENTS, so both lookups are closed over that set. */
const NOTIFY_EVENT_KEY: Record<string, TranslationKey> = {
	completion: "settings.notificationEventCompletion",
	subtask: "settings.notificationEventSubtask",
	error: "settings.notificationEventError",
	question: "settings.notificationEventQuestion",
};

const NOTIFY_EVENT_DESC_KEY: Record<string, TranslationKey> = {
	completion: "settings.notificationEventCompletionDesc",
	subtask: "settings.notificationEventSubtaskDesc",
	error: "settings.notificationEventErrorDesc",
	question: "settings.notificationEventQuestionDesc",
};

const SFX_EVENT_KEY: Record<string, TranslationKey> = {
	send: "settings.sfxEventSend",
	first: "settings.sfxEventFirst",
	complete: "settings.sfxEventComplete",
	question: "settings.sfxEventQuestion",
	approval: "settings.sfxEventApproval",
	"approval-ok": "settings.sfxEventApprovalOk",
	"approval-deny": "settings.sfxEventApprovalDeny",
	subtask: "settings.sfxEventSubtask",
	switch: "settings.sfxEventSwitch",
	stop: "settings.sfxEventStop",
	tool: "settings.sfxEventTool",
	error: "settings.sfxEventError",
};

const SFX_EVENT_DESC_KEY: Record<string, TranslationKey> = {
	send: "settings.sfxEventSendDesc",
	first: "settings.sfxEventFirstDesc",
	complete: "settings.sfxEventCompleteDesc",
	question: "settings.sfxEventQuestionDesc",
	approval: "settings.sfxEventApprovalDesc",
	"approval-ok": "settings.sfxEventApprovalOkDesc",
	"approval-deny": "settings.sfxEventApprovalDenyDesc",
	subtask: "settings.sfxEventSubtaskDesc",
	switch: "settings.sfxEventSwitchDesc",
	stop: "settings.sfxEventStopDesc",
	tool: "settings.sfxEventToolDesc",
	error: "settings.sfxEventErrorDesc",
};

/** Display names for the curated picker; ids stay the persisted value. */
const SOUND_LABEL_KEY: Partial<Record<SoundName, TranslationKey>> = {
	chime: "settings.soundChime",
	sparkle: "settings.soundSparkle",
	ready: "settings.soundReady",
	arrival: "settings.soundArrival",
	pulse: "settings.soundPulse",
	success: "settings.soundSuccess",
	press: "settings.soundPress",
	droplet: "settings.soundDroplet",
	release: "settings.soundRelease",
	error: "settings.soundError",
};

function soundLabel(name: SoundName): string {
	const key = SOUND_LABEL_KEY[name];
	return key ? t(key) : name;
}

/** Events already covered by a notification row; the interaction group keeps
 *  the remaining cues (send, approvals, stop, switch, tool, …). */
const NOTIFICATION_SFX_EVENTS: ReadonlySet<SfxEvent> = new Set(["complete", "question", "subtask", "error"]);
const INTERACTION_SFX_EVENTS: readonly SfxEvent[] = SFX_EVENTS.filter(ev => !NOTIFICATION_SFX_EVENTS.has(ev));

/** One sound choice: preview + palette select (with an explicit "none"). */
function SoundPicker({ ev }: { ev: SfxEvent }): ReactNode {
	const [choice, setChoice] = useState<SfxChoice>(() => soundFor(ev));
	return (
		<div className="gui-sfx-controls">
			<button
				type="button"
				className="gui-sfx-preview"
				disabled={choice === "none"}
				onClick={() => {
					if (choice !== "none") previewSound(choice);
				}}
				aria-label={t("companion.preview")}
				title={t("companion.preview")}
			>
				<Icon name="play" className="h-3.5 w-3.5" />
			</button>
			<GuiSelect
				className="gui-settings-select"
				value={choice}
				onChange={v => {
					const next = v as SfxChoice;
					setChoice(next);
					setSoundFor(ev, next);
				}}
				ariaLabel={t(SFX_EVENT_KEY[ev] ?? ev)}
				options={[
					{ value: "none", label: t("settings.soundNone") },
					...SELECTABLE_SOUNDS.map(sound => ({ value: sound, label: soundLabel(sound) })),
				]}
			/>
		</div>
	);
}

/** Interaction cue row (send / approval / stop / switch / tool …). */
export function SoundEventRow({ ev }: { ev: SfxEvent }): ReactNode {
	return (
		<div className="gui-sfx-event-row">
			<div className="min-w-0 flex-1">
				<div className="gui-settings-row-label">{t(SFX_EVENT_KEY[ev] ?? ev)}</div>
				<div className="gui-settings-row-desc">{t(SFX_EVENT_DESC_KEY[ev] ?? ev)}</div>
			</div>
			<SoundPicker ev={ev} />
		</div>
	);
}

/** Notification event row: desktop toast toggle + its palette sound. */
function NotifyEventRow({
	ev,
	enabled,
	onToggle,
	disabled = false,
}: {
	ev: NotifyEvent;
	enabled: boolean;
	onToggle(): void;
	/** The master notification switch is off: the toast toggle is inert but
	 *  the sound picker stays available (the in-app cue still plays). */
	disabled?: boolean;
}): ReactNode {
	return (
		<div className="gui-sfx-event-row">
			<div className="min-w-0 flex-1">
				<div className="gui-settings-row-label">{t(NOTIFY_EVENT_KEY[ev] ?? ev)}</div>
				<div className="gui-settings-row-desc">{t(NOTIFY_EVENT_DESC_KEY[ev] ?? ev)}</div>
			</div>
			<div className="gui-sfx-controls">
				<button
					type="button"
					role="switch"
					aria-checked={enabled}
					disabled={disabled}
					className={`gui-toggle${enabled ? " gui-toggle--on" : ""}`}
					onClick={onToggle}
					aria-label={t(NOTIFY_EVENT_KEY[ev] ?? ev)}
				>
					<span className="gui-toggle-knob" />
				</button>
				<SoundPicker ev={notifySfxEvent(ev)} />
			</div>
		</div>
	);
}

/** Notification template variables. */
const TEMPLATE_VARIABLES = [
	"project_name",
	"worktree",
	"branch",
	"session_name",
	"agent_name",
	"model_name",
	"last_message",
] as const;

/** Desktop notifications + sound. Delivery switches, one row per event
 *  (toast toggle + palette sound), optional templates, then interaction cues
 *  and their shared volume/quiet-hours controls. */
export function NotificationsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [notify, setNotify] = useState<boolean>(() => notifyEnabled());
	const [focused, setFocused] = useState<boolean>(() => notifyWhileFocused());
	const [notifySound, setNotifySound] = useState<boolean>(() => notifySoundEnabled());
	const [inAppToast, setInAppToast] = useState<boolean>(() => inAppToastEnabled());
	const [eventPrefs, setEventPrefs] = useState<Record<NotifyEvent, boolean>>(() => {
		const out = {} as Record<NotifyEvent, boolean>;
		for (const ev of NOTIFY_EVENTS) out[ev] = eventEnabled(ev);
		return out;
	});
	const [templates, setTemplates] = useState<NotifyTemplates>(() => loadNotifyTemplates());
	const [templatesOpen, setTemplatesOpen] = useState(false);
	const [sound, setSound] = useState<boolean>(() => localStorage.getItem("musepi-gui-sound") !== "0");
	const [hapticOn, setHapticOn] = useState<boolean>(() => localStorage.getItem("musepi-gui-haptic") !== "0");
	// Master volume + quiet hours (免打扰): the in-window flag re-evaluates on
	// a minute tick so the active hint flips without user interaction.
	const [volume, setVolume] = useState<number>(() => volumePref());
	const [quiet, setQuiet] = useState<QuietHours | null>(() => quietHoursPref());
	const [inQuiet, setInQuiet] = useState<boolean>(() => inQuietHours());
	useEffect(() => {
		if (quiet === null) {
			setInQuiet(false);
			return;
		}
		setInQuiet(inQuietHours());
		const id = window.setInterval(() => setInQuiet(inQuietHours()), 60_000);
		return () => window.clearInterval(id);
	}, [quiet]);
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
			<h2 className="gui-settings-page-title">{t("settings.notificationsSound")}</h2>
			<p className="gui-settings-page-desc">{t("settings.notificationsSettings")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.notificationDelivery")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.enableNotifications")}</div>
						<div className="gui-settings-row-desc">{t("settings.enableNotificationsDescription")}</div>
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
						aria-label={t("settings.enableNotifications")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={notify}>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.notifyFocused")}</div>
							<div className="gui-settings-row-desc">{t("settings.notifyFocusedDescription")}</div>
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
							aria-label={t("settings.notifyFocused")}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.notificationSound")}</div>
							<div className="gui-settings-row-desc">{t("settings.notificationSoundDescription")}</div>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={notifySound}
							className={`gui-toggle${notifySound ? " gui-toggle--on" : ""}`}
							onClick={() => {
								const next = !notifySound;
								setNotifySound(next);
								setNotifySoundEnabled(next);
							}}
							aria-label={t("settings.notificationSound")}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.inAppNotifications")}</div>
							<div className="gui-settings-row-desc">{t("settings.inAppNotificationsDescription")}</div>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={inAppToast}
							className={`gui-toggle${inAppToast ? " gui-toggle--on" : ""}`}
							onClick={() => {
								const next = !inAppToast;
								setInAppToast(next);
								setInAppToastEnabled(next);
							}}
							aria-label={t("settings.inAppNotifications")}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.sendTestNotification")}</div>
							<div className="gui-settings-row-desc">{t("settings.sendTestNotificationDescription")}</div>
						</div>
						<button
							type="button"
							className="gui-btn"
							onClick={async () => {
								setTestResult(null);
								const result = await sendTestNotification();
								setTestResult(result);
								if (result.ok && !notifySound) {
									const cue = soundFor("complete");
									if (cue !== "none") previewSound(cue);
								}
							}}
						>
							<Icon name="notification-3" className="h-3.5 w-3.5" />
							{t("settings.sendTestNotification")}
						</button>
						{testResult && (
							<p
								className={
									testResult.ok
										? "text-[13px] text-[var(--color-ok)]"
										: "text-[13px] text-[var(--color-error)]"
								}
							>
								{testResult.ok
									? t("settings.notificationSent")
									: (testResult.reason ?? t("settings.deliveryFailed"))}
							</p>
						)}
					</div>
				</Reveal>
			</div>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.notificationEvents")}</div>
				<div className="gui-sfx-event-list">
					{NOTIFY_EVENTS.map(ev => (
						<NotifyEventRow
							key={ev}
							ev={ev}
							enabled={eventPrefs[ev]}
							disabled={!notify}
							onToggle={() => {
								const next = { ...eventPrefs, [ev]: !eventPrefs[ev] };
								setEventPrefs(next);
								saveEventPrefs(next);
							}}
						/>
					))}
				</div>
			</div>
			<Reveal open={notify}>
				<div className="gui-settings-section">
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.notificationTemplates")}</div>
							<div className="gui-settings-row-desc">{t("settings.templateVariables")}</div>
						</div>
						<button type="button" className="gui-btn" onClick={() => setTemplatesOpen(open => !open)}>
							{templatesOpen ? t("settings.hideNotificationTemplates") : t("settings.editNotificationTemplates")}
						</button>
					</div>
					<Reveal open={templatesOpen}>
						<div className="gui-settings-row-desc">
							{TEMPLATE_VARIABLES.map(v => (
								<code key={v} className="gui-tpl-var">{`{${v}}`}</code>
							))}
						</div>
						<div className="gui-notify-tpl-grid">
							{NOTIFY_EVENTS.map(ev => (
								<div key={ev} className="gui-notify-tpl-group">
									<div className="gui-notify-tpl-name">{t(NOTIFY_EVENT_KEY[ev] ?? ev)}</div>
									<div>
										<label className="gui-notify-tpl-label" htmlFor={`omp-tpl-${ev}-title`}>
											{t("settings.title")}
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
											{t("settings.message")}
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
					</Reveal>
				</div>
			</Reveal>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.soundEffects")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.enableSoundEffects")}</div>
						<div className="gui-settings-row-desc">{t("settings.sendChimeToolClicks")}</div>
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
						aria-label={t("settings.enableSoundEffects")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={sound}>
					{/* Master volume (cuelume engine-global setVolume) — applies
					 * live so the preview buttons double as an audible check. */}
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.masterVolume")}</div>
							<div className="gui-settings-row-desc">{t("settings.masterVolumeDescription")}</div>
						</div>
						<div className="flex items-center gap-2">
							<input
								type="range"
								min={0}
								max={100}
								value={Math.round(volume * 100)}
								className="gui-range w-36"
								aria-label={t("settings.masterVolume")}
								onChange={e => {
									const next = Number(e.target.value) / 100;
									setVolume(next);
									setVolumePref(next);
								}}
							/>
							<span className="w-10 text-right text-[12px] tabular-nums text-[var(--color-text-muted)]">
								{Math.round(volume * 100)}%
							</span>
						</div>
					</div>
					{/* Quiet hours (免打扰时段): event sounds mute inside the
					 * window (overnight wrap supported); previews stay audible. */}
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.quietHours")}</div>
							<div className="gui-settings-row-desc">{t("settings.quietHoursDescription")}</div>
							{quiet !== null && inQuiet && (
								<div className="gui-settings-row-desc text-[var(--color-warning)]">
									{t("settings.quietHoursActive")}
								</div>
							)}
						</div>
						<div className="flex items-center gap-1.5">
							<input
								type="time"
								className="gui-input !w-auto"
								value={quiet?.from ?? ""}
								aria-label={t("settings.quietHours2")}
								onChange={e => {
									const from = e.target.value;
									if (!from) {
										setQuiet(null);
										setQuietHoursPref(null);
										return;
									}
									const next: QuietHours = { from, to: quiet?.to ?? "07:00" };
									setQuiet(next);
									setQuietHoursPref(next);
								}}
							/>
							<span className="text-[12px] text-[var(--color-text-faint)]">→</span>
							<input
								type="time"
								className="gui-input !w-auto"
								value={quiet?.to ?? ""}
								aria-label={t("settings.quietHours3")}
								onChange={e => {
									const to = e.target.value;
									if (!to || !quiet) {
										setQuiet(null);
										setQuietHoursPref(null);
										return;
									}
									const next: QuietHours = { from: quiet.from, to };
									setQuiet(next);
									setQuietHoursPref(next);
								}}
							/>
						</div>
					</div>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">{t("settings.hapticFeedback")}</div>
							<div className="gui-settings-row-desc">{t("settings.hapticFeedbackDescription")}</div>
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
							aria-label={t("settings.hapticFeedback")}
						>
							<span className="gui-toggle-knob" />
						</button>
					</div>
					<div className="gui-settings-row-desc">{t("settings.sfxChoosePerActivity")}</div>
					<div className="gui-settings-section-title">{t("settings.interactionSounds")}</div>
					<div className="gui-settings-row-desc">{t("settings.interactionSoundsDescription")}</div>
					<div className="gui-sfx-event-list">
						{INTERACTION_SFX_EVENTS.map(ev => (
							<SoundEventRow key={ev} ev={ev} />
						))}
					</div>
				</Reveal>
			</div>
			{/* Idle recap (TUI 通知组 parity): daemon-side, persisted to
			 * config.yml — the same recap.enabled / recap.idleSeconds keys
			 * the terminal uses. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("settings.idleRecap")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("settings.interaction.notifications.idleRecap")}</div>
						<div className="gui-settings-row-desc">{t("settings.generateBriefLlm.info")}</div>
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
						aria-label={t("settings.interaction.notifications.idleRecap")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<Reveal open={recapEnabled !== false}>
					<div className="gui-settings-row">
						<div>
							<div className="gui-settings-row-label">
								{t("settings.interaction.notifications.idleRecapDelay")}
							</div>
							<div className="gui-settings-row-desc">{t("settings.secondsWaitWhileIdle")}</div>
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
							ariaLabel={t("settings.interaction.notifications.idleRecapDelay")}
							options={[60, 120, 240, 300, 600].map(seconds => ({
								value: String(seconds),
								label: t("settings.idleRecapDelayOption", { count: String(seconds / 60) }),
							}))}
						/>
					</div>
				</Reveal>
			</div>
		</>
	);
}
