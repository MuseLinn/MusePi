// ============================================================
// /move — pure target resolution for session cwd relocation.
//
// The stateful half (session-file relocation, header rewrite,
// runtime rebind) lives in coding-agent; everything here is pure
// string/path logic with zero host imports so both sides share one
// resolution rule and one equality rule.
// ============================================================

import * as os from "node:os";
import * as path from "node:path";

/**
 * Strip one pair of matching surrounding quotes from a /move argument.
 * The host may pass the raw argument; quoted paths with spaces survive.
 */
export function unquoteMoveInput(input: string): string {
	const trimmed = input.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

/** Expand a leading `~` (or `~/`; `~\` on Windows) to homeDir. */
export function expandMoveHome(input: string, homeDir: string = os.homedir()): string {
	if (input === "~") return homeDir;
	if (input.startsWith("~/") || (process.platform === "win32" && input.startsWith("~\\"))) {
		return path.join(homeDir, input.slice(2));
	}
	return input;
}

/**
 * Resolve a /move target argument to an absolute directory path:
 * unquote, expand `~`, then resolve against the current session cwd.
 */
export function resolveMoveTarget(input: string, cwd: string, homeDir?: string): string {
	const expanded = expandMoveHome(unquoteMoveInput(input), homeDir);
	return path.resolve(cwd, expanded);
}

/**
 * Path equality for move no-op detection. Case-insensitive on Windows,
 * where the filesystem is case-preserving but case-insensitive.
 */
export function sameMovePath(a: string, b: string): boolean {
	const ra = path.resolve(a);
	const rb = path.resolve(b);
	return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}
