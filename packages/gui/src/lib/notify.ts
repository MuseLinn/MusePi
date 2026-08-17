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

/** Event gating: master switch + event toggle + focus mode. */
export function shouldNotify(event: NotifyEvent): boolean {
	if (!notifyEnabled() || !eventEnabled(event)) return false;
	if (typeof document !== "undefined" && document.visibilityState !== "hidden" && !notifyWhileFocused()) {
		return false;
	}
	return true;
}

/** Build the title/body for an event, or null when gated out. */
export function buildNotification(event: NotifyEvent, ctx: NotifyContext): { title: string; body: string } | null {
	if (!shouldNotify(event)) return null;
	const tpl = loadNotifyTemplates()[event];
	const title = renderTemplate(tpl.title || defaultTemplate(event, "title"), ctx);
	const body = renderTemplate(tpl.message || defaultTemplate(event, "message"), ctx);
	return { title, body };
}

/** Electron preload bridge (present inside the desktop shell). */
interface ElectronNotifier {
	showNotification?: (title: string, body: string) => Promise<{ ok?: boolean; reason?: string } | undefined>;
	onNotificationFailed?: (cb: (detail: { title: string; body: string; reason: string }) => void) => () => void;
}

function electronNotifier(): ElectronNotifier | undefined {
	if (typeof window === "undefined") return undefined;
	return (window as unknown as { electronAPI?: ElectronNotifier }).electronAPI;
}

/** Dispatch one notification (session-store calls this on stream events).
 *  Inside the desktop shell the renderer's HTML5 Notification API does not
 *  surface on macOS, so notifications route through the main process
 *  (preload → ipcMain). Plain browsers fall back to the Web API. */
export function dispatchNotification(event: NotifyEvent, ctx: NotifyContext): void {
	if (typeof window === "undefined") return;
	const built = buildNotification(event, ctx);
	if (!built) return;
	const notifier = electronNotifier();
	if (notifier?.showNotification) {
		void notifier.showNotification(built.title, built.body).then((result) => {
			if (result?.ok === false) {
				console.warn("[notify] notification disabled:", result.reason);
			}
		}).catch(() => {});
		return;
	}
	if (!("Notification" in window) || Notification.permission !== "granted") return;
	try {
		new Notification(built.title, { body: built.body, tag: `omp-${event}` });
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
			.showNotification(title, body)
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
	if (!("Notification" in window)) return Promise.resolve({ ok: false, reason: "unsupported" });
	const request =
		Notification.permission === "default"
			? Notification.requestPermission()
			: Promise.resolve(Notification.permission);
	return request.then(permission => {
		if (permission !== "granted") return { ok: false, reason: permission };
		try {
			new Notification(title, { body, tag: "omp-test" });
			return { ok: true };
		} catch (err) {
			return { ok: false, reason: err instanceof Error ? err.message : String(err) };
		}
	});
}
