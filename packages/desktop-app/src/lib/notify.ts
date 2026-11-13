/**
 * Desktop notification prefs + dispatch (Settings → 通知与音效).
 *
 * openchamber parity: a delivery switch (master + focused mode), four
 * event toggles (completion / subtask / error / question) and per-event
 * title/message templates with {variable} substitution. All prefs are
 * renderer-local (localStorage), matching the sound/motion prefs.
 * The store (session-store.ts) is the single dispatch site: every
 * stream event that maps to a notification fires here.
 */

import { type ActionToastKind, pushActionToast } from "./action-toast";
import { inQuietHours, type SfxEvent, sfxFor, soundEnabled } from "./sfx";

const EVENTS = ["completion", "subtask", "error", "question"] as const;
export type NotifyEvent = (typeof EVENTS)[number];
export const NOTIFY_EVENTS: readonly NotifyEvent[] = EVENTS;

export interface NotifyTemplate {
	title: string;
	message: string;
}
export type NotifyTemplates = Record<NotifyEvent, NotifyTemplate>;

const NOTIFY_KEY = "musepi-gui-notify";
const FOCUSED_KEY = "musepi-gui-notify-focused";
const SOUND_KEY = "musepi-gui-notify-sound";
const TOAST_KEY = "musepi-gui-notify-toast";
const EVENTS_KEY = "musepi-gui-notify-events";
const TEMPLATES_KEY = "musepi-gui-notify-templates";

/** Default templates — openchamber's defaults, localized (zh-CN is the
 *  primary locale; English mirrors the openchamber originals). */
const DEFAULT_EN: NotifyTemplates = {
	completion: { title: "{agent_name} is ready", message: "{model_name} completed the task" },
	subtask: { title: "{agent_name} is ready", message: "{model_name} completed the task" },
	error: { title: "Tool error", message: "{last_message}" },
	question: { title: "Input needed", message: "{last_message}" },
};
const DEFAULT_ZH: NotifyTemplates = {
	completion: { title: "{agent_name} 已完成", message: "{model_name} 已完成任务" },
	subtask: { title: "{agent_name} 已完成", message: "{model_name} 已完成任务" },
	error: { title: "工具错误", message: "{last_message}" },
	question: { title: "需要输入", message: "{last_message}" },
};

function isZh(): boolean {
	try {
		return document.documentElement.lang.startsWith("zh");
	} catch {
		return true;
	}
}

/** Placeholder text for an event/field that has no user override. */
export function defaultTemplate(event: NotifyEvent, field: keyof NotifyTemplate): string {
	return (isZh() ? DEFAULT_ZH : DEFAULT_EN)[event][field];
}

export function notifyEnabled(): boolean {
	try {
		return localStorage.getItem(NOTIFY_KEY) !== "0";
	} catch {
		return true;
	}
}

/** true = also notify while the window is focused (openchamber "always"). */
export function notifyWhileFocused(): boolean {
	try {
		return localStorage.getItem(FOCUSED_KEY) === "1";
	} catch {
		return false;
	}
}

/** true = the OS plays the notification sound; false (default) = the in-app
 *  palette cue plays instead, so an event is never heard twice. */
export function notifySoundEnabled(): boolean {
	try {
		return localStorage.getItem(SOUND_KEY) === "1";
	} catch {
		return false;
	}
}

export function setNotifySoundEnabled(enabled: boolean): void {
	try {
		localStorage.setItem(SOUND_KEY, enabled ? "1" : "0");
	} catch {
		// storage unavailable
	}
}

/** In-app bottom-right toast, on by default. It mirrors a delivered
 *  notification event even when the system notification is suppressed by
 *  focus, so the result is still visible inside the window. */
export function inAppToastEnabled(): boolean {
	try {
		return localStorage.getItem(TOAST_KEY) !== "0";
	} catch {
		return true;
	}
}

export function setInAppToastEnabled(enabled: boolean): void {
	try {
		localStorage.setItem(TOAST_KEY, enabled ? "1" : "0");
	} catch {
		// storage unavailable
	}
}

/** Toast tint per notification event. */
const TOAST_KIND: Record<NotifyEvent, ActionToastKind> = {
	completion: "success",
	subtask: "success",
	error: "error",
	question: "warning",
};

/** Notification events reuse the shared sound palette. */
const NOTIFY_SFX: Record<NotifyEvent, SfxEvent> = {
	completion: "complete",
	subtask: "subtask",
	error: "error",
	question: "question",
};

/** The palette event a desktop notification uses. */
export function notifySfxEvent(event: NotifyEvent): SfxEvent {
	return NOTIFY_SFX[event];
}

export function eventEnabled(event: NotifyEvent): boolean {
	try {
		const raw = localStorage.getItem(EVENTS_KEY);
		if (!raw) return true;
		const parsed = JSON.parse(raw) as Partial<Record<NotifyEvent, boolean>>;
		return parsed[event] !== false;
	} catch {
		return true;
	}
}

export function saveEventPrefs(prefs: Record<NotifyEvent, boolean>): void {
	try {
		localStorage.setItem(EVENTS_KEY, JSON.stringify(prefs));
	} catch {
		// storage unavailable
	}
}

/** User overrides — empty fields fall back to defaultTemplate at render. */
export function loadNotifyTemplates(): NotifyTemplates {
	const out: NotifyTemplates = {
		completion: { title: "", message: "" },
		subtask: { title: "", message: "" },
		error: { title: "", message: "" },
		question: { title: "", message: "" },
	};
	try {
		const raw = localStorage.getItem(TEMPLATES_KEY);
		if (!raw) return out;
		const parsed = JSON.parse(raw) as Partial<NotifyTemplates>;
		for (const ev of EVENTS) {
			const tpl = parsed[ev];
			if (tpl && typeof tpl === "object") {
				if (typeof tpl.title === "string") out[ev].title = tpl.title;
				if (typeof tpl.message === "string") out[ev].message = tpl.message;
			}
		}
	} catch {
		// fall back to empty (defaults render)
	}
	return out;
}

export function saveNotifyTemplates(templates: NotifyTemplates): void {
	try {
		localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
	} catch {
		// storage unavailable
	}
}

/** Template variables — openchamber parity. Unresolvable variables
 *  (worktree, branch) render empty: the GUI has no git context source. */
export interface NotifyContext {
	projectName?: string;
	worktree?: string;
	branch?: string;
	sessionName?: string;
	agentName?: string;
	modelName?: string;
	lastMessage?: string;
}

/** Template variable name → context field (openchamber snake_case names). */
const VAR_MAP: Record<string, keyof NotifyContext> = {
	project_name: "projectName",
	worktree: "worktree",
	branch: "branch",
	session_name: "sessionName",
	agent_name: "agentName",
	model_name: "modelName",
	last_message: "lastMessage",
};

export function renderTemplate(template: string, ctx: NotifyContext): string {
	return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
		const key = VAR_MAP[name];
		if (!key) return "";
		const value = ctx[key];
		return typeof value === "string" && value.length > 0 ? value : "";
	});
}

/** Minimal document surface the focus gate reads (SSR / test friendly). */
export interface FocusReport {
	hidden?: boolean;
	hasFocus?: () => boolean;
}

/**
 * Whether the window no longer has the user's attention — i.e. whether a
 * toast can still surprise them.
 *
 * `hidden` covers minimized / another virtual desktop / background tab.
 * `hasFocus` covers the far more common case the old gate missed (issue #14):
 * the window is VISIBLE but the user clicked away to a browser or editor.
 * `visibilityState !== "hidden"` treated that as "the user is right here" and
 * suppressed the notification, so "enable notifications" produced no desktop
 * toast for exactly the sessions the user walked away from.
 */
export function documentUnfocused(doc: FocusReport | undefined): boolean {
	if (!doc) return true;
	if (doc.hidden) return true;
	return typeof doc.hasFocus !== "function" || !doc.hasFocus();
}

/** Event gating: master switch + event toggle + focus mode. */
export function shouldNotify(event: NotifyEvent, doc?: FocusReport): boolean {
	if (!notifyEnabled() || !eventEnabled(event)) return false;
	// Suppress only when the window really holds focus (issue #14) — a
	// visible-but-unfocused window still delivers.
	if (!notifyWhileFocused() && !documentUnfocused(doc ?? ambientDocument())) return false;
	return true;
}

function ambientDocument(): FocusReport | undefined {
	if (typeof document === "undefined") return undefined;
	return document as unknown as FocusReport;
}

/** Render the title/body for an event without applying delivery gates. */
export function renderNotification(event: NotifyEvent, ctx: NotifyContext): { title: string; body: string } {
	const tpl = loadNotifyTemplates()[event];
	const title = renderTemplate(tpl.title || defaultTemplate(event, "title"), ctx);
	const body = renderTemplate(tpl.message || defaultTemplate(event, "message"), ctx);
	return { title, body };
}

/** Build the title/body for an event, or null when gated out. */
export function buildNotification(
	event: NotifyEvent,
	ctx: NotifyContext,
	doc?: FocusReport,
): { title: string; body: string } | null {
	if (!shouldNotify(event, doc)) return null;
	return renderNotification(event, ctx);
}

/** Electron preload bridge (present inside the desktop shell). */
interface ElectronNotifier {
	showNotification?: (
		title: string,
		body: string,
		options?: { silent?: boolean },
	) => Promise<{ ok?: boolean; reason?: string } | undefined>;
	onNotificationFailed?: (cb: (detail: { title: string; body: string; reason: string }) => void) => () => void;
}

function electronNotifier(): ElectronNotifier | undefined {
	if (typeof window === "undefined") return undefined;
	return (window as unknown as { electronAPI?: ElectronNotifier }).electronAPI;
}

/** Dispatch one notification (session-store calls this on stream events).
 *  Inside the desktop shell the renderer's HTML5 Notification API does not
 *  surface on macOS, so notifications route through the main process
 *  (preload → ipcMain). Plain browsers fall back to the Web API.
 *
 *  The same content mirrors into the bottom-right in-app toast stack whenever
 *  notifications for that event are enabled — including while the window is
 *  focused, where the system notification is deliberately suppressed.
 *
 *  One sound per event: when the system notification sound is enabled the OS
 *  plays it and the in-app cue stays silent; otherwise the mapped palette cue
 *  plays (even when desktop notifications are off, so completion is still
 *  audible). Pass `{ silent: true }` only when the caller already played a
 *  cue and wants no second sound. */
export function dispatchNotification(event: NotifyEvent, ctx: NotifyContext, options?: { silent?: boolean }): void {
	const content = renderNotification(event, ctx);
	if (notifyEnabled() && eventEnabled(event) && inAppToastEnabled()) {
		pushActionToast({
			kind: TOAST_KIND[event],
			title: content.title,
			message: content.body,
			dedupeKey: `notify:${event}`,
		});
	}
	const systemSound = notifySoundEnabled() && notifyEnabled() && soundEnabled() && !inQuietHours();
	const callerSilent = options?.silent === true;
	if (!callerSilent && !systemSound) sfxFor(NOTIFY_SFX[event]);
	const notificationSilent = callerSilent || !systemSound;
	if (typeof window === "undefined") return;
	const built = shouldNotify(event) ? content : null;
	if (!built) return;
	const notifier = electronNotifier();
	if (notifier?.showNotification) {
		void notifier
			.showNotification(built.title, built.body, { silent: notificationSilent })
			.then(result => {
				if (result?.ok === false) {
					console.warn("[notify] notification disabled:", result.reason);
				}
			})
			.catch(() => {});
		return;
	}
	// Read the constructor off window, not the bare global: DOM shims can
	// leave a window.Notification key whose value is undefined, and probing
	// `in` while dereferencing the global crashes the caller's flush.
	const Notifier = window.Notification;
	if (Notifier?.permission !== "granted") return;
	try {
		new Notifier(built.title, { body: built.body, tag: `omp-${event}`, silent: notificationSilent });
	} catch {
		// permission revoked mid-flight
	}
}

/** Settings → 通知与音效 → 发送测试通知. Resolves with delivery outcome so
 *  the settings UI can surface success/failure instead of staying silent. */
export function sendTestNotification(): Promise<{ ok: boolean; reason?: string }> {
	if (typeof window === "undefined") return Promise.resolve({ ok: false, reason: "unsupported" });
	const title = isZh() ? "测试通知" : "Test notification";
	const body = isZh() ? "通知设置已生效" : "Notifications are working";
	const silent = !notifySoundEnabled();
	const notifier = electronNotifier();
	if (notifier?.showNotification) {
		const { promise, resolve } = Promise.withResolvers<{ ok: boolean; reason?: string }>();
		let settled = false;
		const finish = (ok: boolean, reason?: string) => {
			if (settled) return;
			settled = true;
			unsubscribe?.();
			resolve({ ok, reason });
		};
		// Main-process delivery can fail asynchronously (macOS unsigned
		// apps → 'failed' event); surface that reason here.
		const unsubscribe = notifier.onNotificationFailed?.(detail => {
			if (detail.title === title && detail.body === body) finish(false, detail.reason);
		});
		void notifier
			.showNotification(title, body, { silent })
			.then((result: unknown) => {
				const r = result as { ok?: boolean; reason?: string } | undefined;
				if (r && r.ok === false) finish(false, r.reason ?? "unauthorized");
				else finish(true);
			})
			.catch(() => finish(false, "ipc-error"));
		// 'failed' fires async after a successful invoke; give it a window
		// before declaring success.
		setTimeout(() => finish(true), 3000);
		return promise;
	}
	const Notifier = window.Notification;
	if (!Notifier) return Promise.resolve({ ok: false, reason: "unsupported" });
	const request =
		Notifier.permission === "default" ? Notifier.requestPermission() : Promise.resolve(Notifier.permission);
	return request.then(permission => {
		if (permission !== "granted") return { ok: false, reason: permission };
		try {
			new Notifier(title, { body, tag: "omp-test", silent });
			return { ok: true };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	});
}
