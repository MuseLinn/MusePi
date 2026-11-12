import { ptree } from "@musepi/pi-utils";
import { parseHookOutput } from "./codec";
import type { CommandHook, HookOutput } from "./types";

/**
 * Run one command hook through the host shell.
 *
 * The process contract is the whole protocol: JSON on stdin, one line, the
 * cwd/env the bridge chose, and exit-code semantics decoded by `codec`. A hook
 * that cannot start (missing shell, unusable cwd) is a non-blocking failure —
 * a broken hook must never take the turn down with it.
 */

/** Reference default per-hook budget (the dialects' own 10 minutes). */
export const DEFAULT_COMMAND_HOOK_TIMEOUT_MS = 600_000;

export interface RunCommandHookOptions {
	cwd: string;
	/** Shell executable used to interpret the command line. */
	shell: string;
	/** Extra environment on top of the inherited one. */
	env?: Record<string, string>;
	/** Applied when the hook sets no `timeout`. */
	defaultTimeoutMs: number;
	signal?: AbortSignal;
	/** Guard for `hookSpecificOutput.hookEventName`. */
	expectedEventName?: string;
}

export interface CommandHookRunResult {
	output: HookOutput;
	durationMs: number;
}

export async function runCommandHook(
	hook: CommandHook,
	payload: unknown,
	options: RunCommandHookOptions,
): Promise<CommandHookRunResult> {
	const started = Date.now();
	const timeoutMs =
		hook.timeoutSec !== undefined && hook.timeoutSec > 0 ? hook.timeoutSec * 1000 : options.defaultTimeoutMs;
	const stdin = `${JSON.stringify(payload)}\n`;
	try {
		const result = await ptree.exec([options.shell, "-c", hook.command], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			input: stdin,
			timeout: timeoutMs,
			...(options.signal ? { signal: options.signal } : {}),
			stderr: "full",
			allowNonZero: true,
			allowAbort: true,
		});
		return {
			output: parseHookOutput(result.exitCode ?? undefined, result.stdout, result.stderr, options.expectedEventName),
			durationMs: Date.now() - started,
		};
	} catch (error) {
		// Infrastructure failure: no exit code, the message on stderr for the record.
		const message = error instanceof Error ? error.message : String(error);
		return {
			output: parseHookOutput(undefined, "", message, options.expectedEventName),
			durationMs: Date.now() - started,
		};
	}
}
