/** Platform-specific options for the launch broker and its non-PTY children. */
export interface DaemonSpawnOptions {
	detached: boolean;
	windowsHide?: boolean;
}

/**
 * Keep launch processes headless without discarding an inheritable Windows console.
 *
 * `surviveParent` marks a process whose lifetime must not be tied to whichever
 * client happened to start it. The daemon broker is the case that matters: any
 * client may be the one that spawns it, and Bun terminates a non-detached child
 * when its parent exits on Windows — so the shared broker, and every daemon it
 * owned, died with whichever client started it first, stranding the other
 * clients that still held its lease. POSIX re-parents orphans to init, so
 * children survive a parent exit there regardless and `detached: true` only
 * gives the broker its own session.
 */
export function resolveDaemonSpawnOptions(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole?: boolean;
	surviveParent?: boolean;
}): DaemonSpawnOptions {
	if (opts.platform !== "win32") return { detached: true };
	// A broker that outlives its spawner has no console to inherit from it;
	// `windowsHide` is what keeps it from opening one of its own.
	if (opts.surviveParent) return { detached: true, windowsHide: true };
	return {
		detached: false,
		windowsHide: !opts.hostHasInheritableConsole,
	};
}
