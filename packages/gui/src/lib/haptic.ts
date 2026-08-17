/**
 * Haptic tap (macOS Taptic Engine) — main-process NSHapticFeedbackManager
 * via the `haptic` IPC. Gated by the Settings toggle (`omp-gui-haptic`,
 * default on) and by the desktop shell's presence (plain browsers have no
 * bridge). macOS-only: on other platforms (and in the web build) this is a
 * no-op — no IPC, no toggle meaning. Patterns: 0 generic, 1 alignment,
 * 2 level-change.
 */
import { shellPlatform } from "./electron";

export function haptic(pattern = 0): void {
	try {
		if (shellPlatform() !== "darwin") return;
		if (localStorage.getItem("omp-gui-haptic") === "0") return;
		const api = (window as unknown as { electronAPI?: { haptic?(p?: number): Promise<unknown> } }).electronAPI;
		void api?.haptic?.(pattern);
	} catch {
		// storage/bridge unavailable — silent
	}
}

/** Haptic + light click sound pair for an action button (the transcript
 *  toolbar and approval cards use this so every interactive tap has both a
 *  tactile and an audible cue). */
export function tapFeedback(pattern = 0): void {
	haptic(pattern);
}
