import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@musepi/pi-utils";

/**
 * Agent-dir isolation for tests that exercise real session storage
 * (daemon suites, SessionManager suites, SDK suites).
 *
 * Without this, a suite whose cwd is a temp directory still resolves the
 * DEFAULT session root as `~/.musepi/agent/sessions/<temp-cwd-slug>/`,
 * littering the developer's (or CI runner's) production session list with
 * throwaway sessions — and on Windows the daemon's open file handles make
 * best-effort `rm -rf` cleanup silently fail, leaving the junk behind.
 *
 * `restoreAgentDirForTest` always restores the agent dir (the isolation
 * contract). Removing the temp tree itself is best-effort: daemon/agent
 * SQLite handles inside it stay open until the test process exits, so a
 * bounded retry is attempted and any residue is left for the OS temp
 * cleaner instead of failing the suite.
 *
 * Usage (bun runs test files sequentially in one process, so save/restore
 * is safe):
 *
 *   let isolatedDir: string;
 *   beforeAll(async () => { isolatedDir = await isolateAgentDirForTest("my-suite-"); });
 *   afterAll(async () => { await restoreAgentDirForTest(isolatedDir); }, 30000);
 */

let originalAgentDir: string | undefined;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

/** Redirect the agent directory (sessions/auth/memories root) into a fresh temp dir. */
export async function isolateAgentDirForTest(prefix: string): Promise<string> {
	if (originalAgentDir === undefined) {
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	}
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	setAgentDir(dir);
	return dir;
}

/** Restore the agent directory captured by the first isolate call and remove the temp dir. */
export async function restoreAgentDirForTest(isolatedDir: string): Promise<void> {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	// The agent dir is fully restored above — this is pure residue cleanup.
	// Daemon/AgentSession SQLite handles stay open until the test process
	// exits, so a bounded retry (≈2s) is enough; whatever survives is left
	// for the OS temp cleaner rather than failing the suite.
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			await fsp.rm(isolatedDir, { recursive: true, force: true });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw err;
			await Bun.sleep(100);
		}
	}
	console.warn(`[isolate-agent-dir] temp agent dir still busy after retries, left for OS cleanup: ${isolatedDir}`);
}
