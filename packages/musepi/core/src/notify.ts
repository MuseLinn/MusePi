// ============================================================
// Terminal notifications (OSC 9) — kimi-code terminal-notification port.
//
// Pure logic, host-agnostic: builds the byte sequences and decides whether
// to fire; the host writes the returned sequences to the terminal.
//
// Semantics (kimi apps/kimi-code/src/tui/utils/terminal-notification.ts):
// - OSC 9 only for an allow-list of known-good terminals (iTerm2, WezTerm,
//   Kitty, Ghostty, Warp); everywhere else degrade to a bare BEL, which is
//   safe on any terminal.
// - Inside tmux the OSC sequence is wrapped in a DCS passthrough with ESC
//   bytes doubled, otherwise tmux swallows it. BEL needs no wrapping.
// - `condition: "unfocused"` suppresses the notification while the
//   terminal has focus, and each `key` fires at most once.
// ============================================================

export const BEL = "\x07";
export const ESC = "\x1b";
export const ST = "\\";
export const MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH = 120;

export interface TerminalNotification {
	readonly title: string;
	readonly body?: string | undefined;
}

export interface NotificationBuildOptions {
	readonly supportsOsc9: boolean;
	readonly insideTmux: boolean;
}

export type NotificationCondition = "always" | "unfocused";

export interface NotificationGateState {
	/** Whether the terminal window currently has focus. */
	focused: boolean;
	/** Keys that already fired (same key never notifies twice). */
	readonly sentKeys: Set<string>;
}

export interface NotificationGateOptions {
	readonly enabled: boolean;
	readonly condition: NotificationCondition;
}

/**
 * Once-per-key notification gate. Returns the sequences to write (possibly
 * empty), or null when the notification is suppressed entirely.
 */
export function notifyTerminalOnce(
	gate: NotificationGateOptions,
	state: NotificationGateState,
	key: string,
	notification: TerminalNotification,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (!gate.enabled) return [];
	if (state.sentKeys.has(key)) return [];
	state.sentKeys.add(key);
	if (gate.condition === "unfocused" && state.focused) return [];
	return buildTerminalNotificationSequences(notification, {
		supportsOsc9: supportsOsc9Notification(env),
		insideTmux: isInsideTmux(env),
	});
}

/**
 * Build the OSC/BEL bytes for a terminal notification.
 *
 * - `supportsOsc9 === true`: a single OSC 9 sequence (desktop notification
 *   on iTerm2, WezTerm, Kitty, Ghostty, Warp).
 * - `supportsOsc9 === false`: a bare BEL fallback.
 * - `insideTmux === true` (OSC 9 only): tmux DCS passthrough with doubled
 *   ESC bytes; BEL passes through unchanged.
 */
export function buildTerminalNotificationSequences(
	notification: TerminalNotification,
	options: NotificationBuildOptions,
): string[] {
	const message = formatNotification(notification);
	if (message.length === 0) return [];
	if (!options.supportsOsc9) {
		return [BEL];
	}
	const osc9 = `${ESC}]9;${message}${BEL}`;
	if (options.insideTmux) {
		const escaped = osc9.replaceAll(ESC, `${ESC}${ESC}`);
		return [`${ESC}Ptmux;${escaped}${ESC}${ST}`];
	}
	return [osc9];
}

export function formatNotification(notification: TerminalNotification): string {
	const title = sanitizeNotificationText(notification.title);
	const body = sanitizeNotificationText(notification.body ?? "");
	const message = title.length > 0 && body.length > 0 ? `${title}: ${body}` : title.length > 0 ? title : body;
	return message.slice(0, MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH);
}

/**
 * Best-effort OSC 9 support detection from environment variables. The
 * allow-list is intentionally short and conservative: BEL is safe
 * everywhere, while OSC 9 on a terminal that does not grok it prints
 * escape garbage.
 */
export function supportsOsc9Notification(env: NodeJS.ProcessEnv = process.env): boolean {
	const termProgram = env["TERM_PROGRAM"] ?? "";
	if (
		termProgram === "iTerm.app" ||
		termProgram === "WezTerm" ||
		termProgram === "ghostty" ||
		termProgram === "WarpTerminal"
	) {
		return true;
	}
	const term = env["TERM"] ?? "";
	if (term === "xterm-kitty" || term === "xterm-ghostty") return true;
	return false;
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
	const tmux = env["TMUX"] ?? "";
	return tmux.length > 0;
}

function sanitizeNotificationText(value: string): string {
	return Array.from(value)
		.map((ch) => (isControlCharacter(ch) ? " " : ch))
		.join("")
		.replaceAll(/\s+/g, " ")
		.trim();
}

function isControlCharacter(ch: string): boolean {
	const code = ch.codePointAt(0) ?? 0;
	return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}
