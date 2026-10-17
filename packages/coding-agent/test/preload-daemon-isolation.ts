// Test-global daemon isolation: every daemon booted by a suite must
// journal/persist/socket under a throwaway tree, never the production
// `%TEMP%/musepi-daemon` dir — otherwise test sessions litter the user's
// sidebar (journals with no transcript) and two daemons race the
// materialized.db lock and the journal compaction rename (both crash).
//
// Runs before any test file (bunfig [test] preload lists this first),
// so session-host's module-level SOCKET_DIR/JOURNAL_DIR constants pick
// the isolated dir up at import. Respects an explicitly provided
// MUSEPI_DAEMON_DIR (CI sharding, dev-smoke wrappers). Only node:
// builtins here — importing src would freeze the dirs before this runs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = process.env.MUSEPI_DAEMON_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), "musepi-test-daemon-"));
process.env.MUSEPI_DAEMON_DIR = dir;

process.on("exit", () => {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Windows handles may still be held (daemon sockets close late) —
		// the OS temp cleaner reclaims the rest. Never fail the run here.
	}
});
