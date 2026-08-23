/**
 * Windows spawn guard — 全局消灭子进程控制台窗口弹窗。
 *
 * 背景:Windows 上 `Bun.spawn`/`Bun.spawnSync` 默认(不带 windowsHide)会为
 * 每个子进程创建新的控制台窗口。daemon 由 GUI 以 detached+windowsHide 启动
 * (无自己的 console),它再 spawn 的每个 git/gh/shell/powershell 子进程都会
 * 弹出一个终端窗口——设置-Git 面板一次 4 个并发 probe = 4 个弹窗。
 *
 * 修法:参考 opencode 的集中 spawn 层(cross-spawn-spawner.ts 统一注入
 * `windowsHide: process.platform === "win32"`)思路,但更进一步——直接
 * patch Bun 全局。daemon 启动时安装一次,进程内所有 spawn 调用点(包括
 * 未来新增的)自动带 windowsHide,不会再有遗漏。
 *
 * 关键坑:Bun.spawn 有两种重载——
 *   1. 数组形式 `Bun.spawn(["cmd", ...], { opts })` — opts 是第二参数
 *   2. 对象形式 `Bun.spawn({ cmd: ["cmd", ...], ...opts })` — 所有选项
 *      都在第一个对象里,Bun **忽略第二参数**!
 * 所以注入必须识别对象形式,直接改第一个对象;只塞第二参数对对象形式
 * 静默失效(实测 cwd 冲突时对象里的值胜出,第二参数完全被丢弃)。
 *
 * 各参考实现:
 * - opencode: 集中 spawn 封装,统一 `windowsHide: process.platform === "win32"`
 * - bitfun: managed-host 每个 spawn 显式 windowsHide + Rust CREATE_NO_WINDOW
 * - proma: Electron main 每个 spawn 显式 windowsHide
 *
 * 本 guard 是全局兜底;调用点已有的显式 windowsHide 保持原样(幂等,后续
 * 也允许调用点覆盖)。
 */

/** Bun.spawn first arg: array (cmd form) or SpawnOptions object. */
type SpawnCmd = Parameters<typeof Bun.spawn>[0];
/** SpawnOptions object shape (the object form carries `cmd` inside). */
interface SpawnOptionsObject {
	cmd?: readonly string[];
	windowsHide?: boolean;
	[key: string]: unknown;
}

function isOptionsObject(cmd: SpawnCmd): cmd is SpawnOptionsObject {
	return typeof cmd === "object" && cmd !== null && !Array.isArray(cmd) && "cmd" in cmd;
}

function isArrayCmd(cmd: SpawnCmd): cmd is readonly string[] {
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
		const [cmd, options] = args;
		// Object form: inject into the FIRST argument (Bun ignores a second
		// arg here — verified: cwd in the object beats cwd in extra opts).
		if (isOptionsObject(cmd)) {
			if (cmd.windowsHide === undefined) {
				const merged: SpawnOptionsObject = { ...cmd, windowsHide: true };
				return originalSpawn(merged as SpawnCmd, options);
			}
			return originalSpawn(cmd as SpawnCmd, options);
		}
		// Array form: options is the second arg — inject there.
		if (isArrayCmd(cmd)) {
			const opts = (options ?? {}) as Record<string, unknown>;
			if (opts.windowsHide === undefined) {
				opts.windowsHide = true;
				return originalSpawn(cmd as SpawnCmd, opts as never);
			}
			return originalSpawn(cmd as SpawnCmd, options);
		}
		// Unrecognized shape — pass through untouched.
		return originalSpawn(cmd as SpawnCmd, options);
	}) as typeof Bun.spawn;

	(Bun as unknown as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
		const [cmd, options] = args;
		if (isOptionsObject(cmd)) {
			if (cmd.windowsHide === undefined) {
				const merged: SpawnOptionsObject = { ...cmd, windowsHide: true };
				return originalSpawnSync(merged as Parameters<typeof Bun.spawnSync>[0], options);
			}
			return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], options);
		}
		if (isArrayCmd(cmd)) {
			const opts = (options ?? {}) as Record<string, unknown>;
			if (opts.windowsHide === undefined) {
				opts.windowsHide = true;
				return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], opts as never);
			}
			return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], options);
		}
		return originalSpawnSync(cmd as Parameters<typeof Bun.spawnSync>[0], options);
	}) as typeof Bun.spawnSync;

	(Bun.spawn as unknown as { __musepiGuard: boolean }).__musepiGuard = true;
}
