/**
 * Windows spawn guard — global elimination of child-process console popups.
 *
 * Background: on Windows, `Bun.spawn`/`Bun.spawnSync` default to spawning a
 * new console window for every child. The daemon is launched by the GUI as
 * detached + windowsHide (no console of its own), so any spawn without the
 * flag leaks a visible conhost window — setting-Git probing once could pop
 * four windows.
 *
 * Fix: mirror opencode's cross-spawn-spawner.ts centralized `windowsHide`
 * injection, but split across two layers because the two spawn APIs have
 * very different patchability:
 *
 *  - `Bun.spawn`/`Bun.spawnSync`: Bun owns these globals, so we patch them
 *    in-process — the guard is the single choke point for every Bun spawn
 *    (current and future call sites), installed once at daemon bootstrap.
 *
 *  - `node:child_process.spawn`/`spawnSync`: ESM builtin namespaces are
 *    immutable bindings — they cannot be patched at runtime. Instead,
 *    `@musepi/pi-utils/nodespawn.ts` provides `spawn`/`spawnSync` wrappers
 *    that inject `windowsHide: true` on win32; call sites must import from
 *    that module (see guard comment).
 *
 * Key gotcha: Bun.spawn has two overloads —
 *   1. Array form `Bun.spawn(["cmd", ...], { opts })` — opts is second arg
 *   2. Object form `Bun.spawn({ cmd: ["cmd", ...], ...opts })` — all options
 *      live in the first object; Bun ignores a second arg here.
 * So injection must detect the object form and mutate the first argument.
 *
 * Each reference implementation:
 * - opencode: cross-spawn-spawner.ts injects `windowsHide: process.platform === "win32"` in its single spawn layer
 * - bitfun: managed-host each spawn explicitly sets windowsHide + Rust CREATE_NO_WINDOW
 * - proma: Electron main each spawn explicitly sets windowsHide
 *
 * This guard covers Bun.*; the `node:child_process` counterpart lives in
 * `@musepi/pi-utils/nodespawn.ts`.
 */

type SpawnCmd = Parameters<typeof Bun.spawn>[0];
/** SpawnOptions object shape (the object form carries `cmd` inside). */
interface SpawnOptionsObject {
	cmd?: readonly string[];
	windowsHide?: boolean;
	[key: string]: unknown;
}

function isOptionsObject(cmd: unknown): cmd is SpawnOptionsObject {
	return typeof cmd === "object" && cmd !== null && !Array.isArray(cmd) && "cmd" in cmd;
}

function isArrayCmd(cmd: unknown): cmd is readonly string[] {
	return Array.isArray(cmd);
}

/**
 * Install the guard. Idempotent; no-op off win32. Must run before any
 * child process is spawned in this process (daemon bootstrap).
 */
export function installWindowsSpawnGuard(): void {
	if (process.platform !== "win32") return;
	// Guard against double-install (daemon re-entry in tests / hot reload).
	if ((Bun.spawn as unknown as { __musepiGuard?: boolean }).__musepiGuard) return;

	const originalSpawn = Bun.spawn;
	const originalSpawnSync = Bun.spawnSync;

	(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((...args: Parameters<typeof Bun.spawn>) => {
		const [cmd, options] = args as [unknown, Parameters<typeof Bun.spawn>[1]];
		// Object form: inject into the FIRST argument (Bun ignores a second
		// arg here — verified: cwd in the object beats cwd in extra opts).
		if (isOptionsObject(cmd)) {
			if (cmd.windowsHide === undefined) {
				const merged: SpawnOptionsObject = { ...cmd, windowsHide: true };
				return originalSpawn(merged as unknown as SpawnCmd, options);
			}
			return originalSpawn(cmd as unknown as SpawnCmd, options);
		}
		// Array form: options is the second arg — inject there.
		if (isArrayCmd(cmd)) {
			const opts = (options ?? {}) as Record<string, unknown>;
			if (opts.windowsHide === undefined) {
				opts.windowsHide = true;
				return originalSpawn(cmd as unknown as SpawnCmd, opts as never);
			}
			return originalSpawn(cmd as unknown as SpawnCmd, options);
		}
		// Unrecognized shape — pass through untouched.
		return originalSpawn(cmd as unknown as SpawnCmd, options);
	}) as typeof Bun.spawn;

	(Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
		const [cmd, options] = args as [unknown, Parameters<typeof Bun.spawnSync>[1]];
		if (isOptionsObject(cmd)) {
			if (cmd.windowsHide === undefined) {
				const merged: SpawnOptionsObject = { ...cmd, windowsHide: true };
				return originalSpawnSync(merged as unknown as Parameters<typeof Bun.spawnSync>[0], options);
			}
			return originalSpawnSync(cmd as unknown as Parameters<typeof Bun.spawnSync>[0], options);
		}
		if (isArrayCmd(cmd)) {
			const opts = (options ?? {}) as Record<string, unknown>;
			if (opts.windowsHide === undefined) {
				opts.windowsHide = true;
				return originalSpawnSync(cmd as unknown as Parameters<typeof Bun.spawnSync>[0], opts as never);
			}
			return originalSpawnSync(cmd as unknown as Parameters<typeof Bun.spawnSync>[0], options);
		}
		return originalSpawnSync(cmd as unknown as Parameters<typeof Bun.spawnSync>[0], options);
	}) as typeof Bun.spawnSync;

	(Bun.spawn as unknown as { __musepiGuard: boolean }).__musepiGuard = true;
}
