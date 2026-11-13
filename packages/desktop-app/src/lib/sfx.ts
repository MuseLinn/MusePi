import { play, type SoundName, setVolume, sounds } from "cuelume";

/**
 * Curated interaction sounds (cuelume — Web Audio, no assets).
 * Called from UI actions; failures are silent (audio may be blocked
 * before the first user gesture, which browsers handle automatically).
 */
/** Effects preferences (Settings → 效果): sound on/off + motion level. */
export function soundEnabled(): boolean {
	try {
		return localStorage.getItem("musepi-gui-sound") !== "0";
	} catch {
		return true;
	}
}

export function motionLevel(): "full" | "reduced" | "off" {
	try {
		return (localStorage.getItem("musepi-gui-motion") as "full" | "reduced" | "off") ?? "full";
	} catch {
		return "full";
	}
}

export function sfx(name: SoundName): void {
	if (!soundEnabled()) return;
	try {
		play(name);
	} catch {
		// audio context not ready — ignore
	}
}

/**
 * Activity → sound mapping. Every wired activity is configurable in
 * Settings → 通知与音效; the chosen sound is stored renderer-local under
 * `musepi-gui-sfx:<event>`, defaulting to DEFAULT_SFX. `none` is a real
 * choice: noisy activities (tool results, session switches) start silent.
 */
export type SfxChoice = SoundName | "none";

export type SfxEvent =
	| "send" // 发送消息
	| "first" // 首次消息 / 提示增强
	| "complete" // agent 回合完成（消息结束）
	| "question" // 提问等待回答
	| "approval" // 审批请求到达
	| "approval-ok" // 审批通过
	| "approval-deny" // 审批拒绝
	| "subtask" // 子智能体完成
	| "switch" // 切换会话
	| "stop" // 停止当前回合
	| "tool" // 工具结果到达
	| "error"; // 错误（连接失败等）

export const SFX_EVENTS: readonly SfxEvent[] = [
	"send",
	"first",
	"complete",
	"question",
	"approval",
	"approval-ok",
	"approval-deny",
	"subtask",
	"switch",
	"stop",
	"tool",
	"error",
];

export const DEFAULT_SFX: Record<SfxEvent, SfxChoice> = {
	send: "chime",
	first: "sparkle",
	complete: "ready",
	question: "arrival",
	approval: "pulse",
	"approval-ok": "success",
	"approval-deny": "press",
	subtask: "droplet",
	switch: "none",
	stop: "release",
	tool: "none",
	error: "error",
};

const SOUND_SET: ReadonlySet<string> = new Set(sounds);

function prefKey(ev: SfxEvent): string {
	return `musepi-gui-sfx:${ev}`;
}

/** The configured sound for an activity (falls back to the default when the
 *  stored name is missing, `none`, or no longer in the palette). */
export function soundFor(ev: SfxEvent): SfxChoice {
	try {
		const stored = localStorage.getItem(prefKey(ev));
		if (stored === "none" || (stored && SOUND_SET.has(stored))) return stored as SfxChoice;
	} catch {
		// storage unavailable — default
	}
	return DEFAULT_SFX[ev];
}

/** Persist an activity's sound choice (`none` mutes that activity). */
export function setSoundFor(ev: SfxEvent, choice: SfxChoice): void {
	try {
		localStorage.setItem(prefKey(ev), choice);
	} catch {
		// storage unavailable — session-only
	}
}

/** Play the configured sound for an activity (master toggle + quiet-hours
 *  gated; explicit previews bypass both deliberately). */
export function sfxFor(ev: SfxEvent): void {
	if (!soundEnabled()) return;
	if (inQuietHours()) return;
	const choice = soundFor(ev);
	if (choice === "none") return;
	try {
		play(choice);
	} catch {
		// audio context not ready — ignore
	}
}

// ── Master volume (cuelume setVolume — engine-global 0..1) ─────────────

const VOLUME_KEY = "musepi-gui-volume";

/** The persisted master volume 0..1 (default 1). */
export function volumePref(): number {
	try {
		const raw = Number(localStorage.getItem(VOLUME_KEY));
		if (Number.isFinite(raw) && raw >= 0 && raw <= 1) return raw;
	} catch {
		// storage unavailable — default
	}
	return 1;
}

/** Persist + apply the master volume (0..1). */
export function setVolumePref(v: number): void {
	const clamped = Math.min(1, Math.max(0, v));
	try {
		localStorage.setItem(VOLUME_KEY, String(clamped));
	} catch {
		// storage unavailable — session-only
	}
	try {
		setVolume(clamped);
	} catch {
		// engine not ready — applied on next play
	}
}

// Apply the persisted volume once at module load (cuelume defaults to 1).
try {
	setVolume(volumePref());
} catch {
	// engine not ready — the next setVolumePref call applies it
}

// ── Quiet hours (免打扰时段 — event sounds muted inside the window) ────

const QUIET_KEY = "musepi-gui-quiet-hours";

export interface QuietHours {
	/** "HH:mm" start/end; a window may wrap midnight (from > to). */
	from: string;
	to: string;
}

/** The persisted quiet-hours window, or null when unset. */
export function quietHoursPref(): QuietHours | null {
	try {
		const raw = localStorage.getItem(QUIET_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Partial<QuietHours>;
		if (
			typeof parsed.from === "string" &&
			typeof parsed.to === "string" &&
			/^\d{2}:\d{2}$/.test(parsed.from) &&
			/^\d{2}:\d{2}$/.test(parsed.to)
		) {
			return { from: parsed.from, to: parsed.to };
		}
	} catch {
		// malformed storage — treat as unset
	}
	return null;
}

export function setQuietHoursPref(value: QuietHours | null): void {
	try {
		if (value) localStorage.setItem(QUIET_KEY, JSON.stringify(value));
		else localStorage.removeItem(QUIET_KEY);
	} catch {
		// storage unavailable — session-only
	}
}

const minutesOf = (hhmm: string): number => {
	const [h, m] = hhmm.split(":").map(part => Number.parseInt(part, 10));
	return (h ?? 0) * 60 + (m ?? 0);
};

/** True when the current local time is inside the quiet window (handles the
 *  overnight wrap, e.g. 23:00–07:00). */
export function inQuietHours(): boolean {
	const q = quietHoursPref();
	if (!q) return false;
	const now = new Date();
	const cur = now.getHours() * 60 + now.getMinutes();
	const from = minutesOf(q.from);
	const to = minutesOf(q.to);
	return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

/** The full cuelume palette (17 synthesized recipes). */
export const ALL_SOUNDS: readonly SoundName[] = sounds;

/** Sounds that have a default trigger; the picker offers only these so the
 *  palette stays meaningful (no unwired gallery). */
export const WIRED_SOUNDS: ReadonlySet<SoundName> = new Set(
	Object.values(DEFAULT_SFX).filter((name): name is SoundName => name !== "none"),
);

/** Curated order for the per-event sound picker. */
export const SELECTABLE_SOUNDS: readonly SoundName[] = [
	"chime",
	"sparkle",
	"ready",
	"arrival",
	"pulse",
	"success",
	"press",
	"droplet",
	"release",
	"error",
];

/** Settings preview — plays the recipe directly, deliberately bypassing the
 * master toggle so a muted user can still audition the palette. */
export function previewSound(name: SoundName): void {
	try {
		play(name);
	} catch {
		// audio context not ready — ignore
	}
}
