import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, getConfigRootDir, setAgentDir } from "@musepi/pi-utils";

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

/** Snapshot of the config-root env a suite redirected, for exact restore. */
let originalConfigDir: string | undefined;
let configDirIsolated = false;

/**
 * Redirect the CONFIG ROOT (`~/.musepi`, `PI_CONFIG_DIR`-relocatable) into a
 * fresh temp dir. The agent dir holds sessions/auth; the config root holds
 * host-level stores like `crons.json` and `crons.runs.json`. `setAgentDir`
 * does NOT move the config root, so a suite that writes the cron store
 * (ScheduleService `start()`/`saveCronTasks`) must isolate this too — or it
 * seeds a task into the developer's real task center (the "nightly report
 * keeps coming back" bug: the schedule-ledger test's fixture leaked into
 * `~/.musepi/crons.json`).
 *
 * Pair with {@link restoreConfigRootForTest}. Independent of the agent-dir
 * isolation: a suite may use either or both.
 */
export async function isolateConfigRootForTest(prefix: string): Promise<string> {
	if (!configDirIsolated) {
		originalConfigDir = process.env.PI_CONFIG_DIR;
		configDirIsolated = true;
	}
	const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
	process.env.PI_CONFIG_DIR = dir;
	// Rebuild the resolver from the new env so getConfigRootDir() (and every
	// derived path) points into the temp tree.
	__resetDirsFromEnvForTests();
	return dir;
}

/** Restore the config root captured by the first isolate call and remove the temp dir. */
export async function restoreConfigRootForTest(isolatedDir: string): Promise<void> {
	if (!configDirIsolated) return;
	if (originalConfigDir === undefined) {
		delete process.env.PI_CONFIG_DIR;
	} else {
		process.env.PI_CONFIG_DIR = originalConfigDir;
	}
	configDirIsolated = false;
	__resetDirsFromEnvForTests();
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
}

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
