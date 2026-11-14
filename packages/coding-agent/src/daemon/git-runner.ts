/**
 * Git process runner for the daemon git.* RPCs.
 *
 * Spawning is async on purpose: a `spawnSync` here once froze every daemon
 * connection for the duration of a `git.log`, and every runner carries a kill
 * guard so a git that blocks on the network, a hook, or a network filesystem
 * cannot pin an RPC open forever. Read and write failures are reported
 * differently — a read returns git's own words so the surface can render a
 * "not a repository" state, while a failed write throws with stderr because
 * the tree is already changed and "why" is the useful part.
 */

/**
 * Spawn `git` for the daemon git.* RPCs with a hard timeout — fetch/pull hit
 * the network and must never pin the daemon event loop. Same contract as
 * `runGh`: `exitCode` is null only when the spawn itself failed.
 */
export async function runGit(
	cwd: string,
	args: string[],
	timeoutMs = 30_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// already exited
		}
	}, timeoutMs);
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited.catch(() => null),
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

/**
 * Run git for a write RPC.
 *
 * Separate from {@link runGitRead} because the failure modes differ. A write
 * that fails leaves the tree changed, so the error carries git's own stderr —
 * "your local changes would be overwritten" is the answer to why a revert did
 * not happen, and a generic "git exited 1" sends the reader to the terminal to
 * find out. A write also gets a longer kill guard: revert legitimately waits on
 * a commit hook, and killing it halfway is worse than waiting.
 */
export async function runGitWrite(cwd: string, args: readonly string[], timeoutMs = 60_000): Promise<void> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const guard = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// already exited
		}
	}, timeoutMs);
	try {
		const [exitCode, , stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0] ?? ""} exited ${exitCode}`);
	} finally {
		clearTimeout(guard);
	}
}

/**
 * Run git for a read-only RPC.
 *
 * Async rather than sync because a synchronous spawn blocks the daemon's event
 * loop for the duration — `git.log` records that a `spawnSync` here froze every
 * connection at once. The kill guard is for the same reason `git.log` carries
 * one: a git that hangs on a network filesystem or a hook must not pin the RPC
 * open indefinitely.
 *
 * Returns git's own words on failure rather than throwing, because every caller
 * surfaces a missing repository as a view state rather than as an error dialog.
 */
export async function runGitRead(
	cwd: string,
	args: readonly string[],
	timeoutMs = 10_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});
	const guard = setTimeout(() => {
		try {
			proc.kill();
		} catch {
			// already exited
		}
	}, timeoutMs);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited.catch(() => null),
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		clearTimeout(guard);
	}
}
