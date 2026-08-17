import { play, type SoundName, sounds } from "cuelume";

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
 * Activity → sound mapping (opencode-style per-category sounds). Every
 * wired activity is configurable in Settings → 通知与音效; the chosen sound
 * is stored renderer-local under `musepi-gui-sfx:<event>`, defaulting to
 * DEFAULT_SFX. `sfxFor` is what call sites use; `sfx(name)` stays for
 * one-off/preview plays.
 */
export type SfxEvent =
	| "send" // 发送消息
	| "first" // 首次消息 / 提示增强
	| "complete" // agent 回合完成（消息结束）
	| "approval" // 审批请求到达
	| "approval-ok" // 审批通过
	| "approval-deny" // 审批拒绝
	| "switch" // 切换会话
	| "stop" // 停止当前回合
	| "tool" // 工具结果到达
	| "error"; // 错误（连接失败等）

export const SFX_EVENTS: readonly SfxEvent[] = [
	"send",
	"first",
	"complete",
	"approval",
	"approval-ok",
	"approval-deny",
	"switch",
	"stop",
	"tool",
	"error",
];

export const DEFAULT_SFX: Record<SfxEvent, SoundName> = {
	send: "chime",
	first: "sparkle",
	complete: "ready",
	approval: "chime",
	"approval-ok": "success",
	"approval-deny": "error",
	switch: "page",
	stop: "release",
	tool: "tick",
	error: "error",
};

const SOUND_SET: ReadonlySet<string> = new Set(sounds);

function prefKey(ev: SfxEvent): string {
	return `musepi-gui-sfx:${ev}`;
}

/** The configured sound for an activity (falls back to the default when the
 *  stored name is missing or no longer in the palette). */
export function soundFor(ev: SfxEvent): SoundName {
	try {
		const stored = localStorage.getItem(prefKey(ev));
		if (stored && SOUND_SET.has(stored)) return stored as SoundName;
	} catch {
		// storage unavailable — default
	}
	return DEFAULT_SFX[ev];
}

/** Persist an activity's sound choice. */
export function setSoundFor(ev: SfxEvent, name: SoundName): void {
	try {
		localStorage.setItem(prefKey(ev), name);
	} catch {
		// storage unavailable — session-only
	}
}

/** Play the configured sound for an activity (master toggle gated). */
export function sfxFor(ev: SfxEvent): void {
	if (!soundEnabled()) return;
	try {
		play(soundFor(ev));
	} catch {
		// audio context not ready — ignore
	}
}

/** The full cuelume palette (14 synthesized recipes) — surfaced with
 * preview buttons in Settings → 通知与音效. */
export const ALL_SOUNDS: readonly SoundName[] = sounds;

/** Names actually wired into the UI (sfxFor call sites). The remaining
 * recipes are palette-only until a trigger is added. */
export const WIRED_SOUNDS: ReadonlySet<SoundName> = new Set(Object.values(DEFAULT_SFX));

/** Settings preview — plays the recipe directly, deliberately bypassing the
 * master toggle so a muted user can still audition the palette. */
export function previewSound(name: SoundName): void {
	try {
		play(name);
	} catch {
		// audio context not ready — ignore
	}
}
