export declare function resetAgentStoresForTest(): void;
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
export declare function isolateConfigRootForTest(prefix: string): Promise<string>;
/** Restore the config root captured by the first isolate call and remove the temp dir. */
export declare function restoreConfigRootForTest(isolatedDir: string): Promise<void>;
/** Redirect the agent directory (sessions/auth/memories root) into a fresh temp dir. */
export declare function isolateAgentDirForTest(prefix: string): Promise<string>;
/** Restore the agent directory captured by the first isolate call and remove the temp dir. */
export declare function restoreAgentDirForTest(isolatedDir: string): Promise<void>;
