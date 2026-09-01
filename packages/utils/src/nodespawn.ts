/**
 * Central node:child_process spawn layer — Windows console-window elimination.
 *
 * The daemon is console-less (GUI-hosted); every `node:child_process.spawn`
 * without `windowsHide: true` allocates a visible conhost window per child.
 * Unlike `Bun.spawn` (patched globally by coding-agent's windows-spawn-guard),
 * the `node:child_process` module namespace cannot be patched — so all spawn
 * call sites must import from this module instead of `node:child_process`
 * directly. On win32 the default `windowsHide: true` is injected unless the
 * caller explicitly overrides.
 *
 * Reference: opencode's cross-spawn-spawner.ts injects
 * `windowsHide: process.platform === "win32"` in its single spawn layer.
 */

import { type ChildProcess, type ChildProcessByStdio, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

type StdioStream<Flag extends string> = Flag extends "pipe" | "inherit" ? Readable : null;
type StdioInput<Flag extends string> = Flag extends "pipe" | "inherit" ? Writable : null;

/**
 * Central spawn: forwards to `node:child_process.spawn` with
 * `windowsHide: true` defaulted on win32 (explicit caller value wins).
 * The `const` type parameter keeps stdio arrays as literal tuples so the
 * mapped result preserves node's per-stream nullability (ChildProcessByStdio).
 */
export function spawn<const O extends SpawnOptions>(
	command: string,
	args: readonly string[],
	options?: O,
): O extends { stdio: readonly [infer In, infer Out, infer Err] }
	? ChildProcessByStdio<StdioInput<In & string>, StdioStream<Out & string>, StdioStream<Err & string>>
	: ChildProcess {
	const merged: SpawnOptions = process.platform !== "win32" ? (options ?? {}) : { windowsHide: true, ...options };
	return nodeSpawn(command, args, merged) as never;
}
