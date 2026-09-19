/**
 * Daemon/GUI version staleness check (pure, unit-testable).
 *
 * A daemon spawned by this GUI carries MUSEPI_VERSION = the GUI version
 * (daemon.cjs injects it on spawn). A daemon from a CLI install,
 * launch-at-login, or another instance reports `musepiVersion: null` and
 * `version` = the engine version compiled into that binary. Either way, a
 * mismatch against the running GUI's version means the daemon predates
 * this GUI and must be restarted — otherwise the settings page shows a
 * stale version and the daemon may lack new features.
 */
export function shouldRestartDaemon(
	meta: { version?: string; musepiVersion?: string | null } | null,
	appVersion: string | null,
): boolean {
	if (!appVersion) return false;
	if (!meta) return false;
	const daemonVersion = meta.musepiVersion ?? meta.version ?? null;
	return daemonVersion !== null && daemonVersion !== appVersion;
}

/**
 * RPCs whose absence means the daemon predates this GUI.
 *
 * Version equality is NOT sufficient evidence that a daemon is current. In
 * dev — and for anyone running from a worktree — the code advances while
 * `package.json` version stays put, so a long-lived daemon from before a
 * feature landed still reports the same `musepiVersion` as the fresh GUI.
 * `shouldRestartDaemon` then correctly returns false and the user is left
 * staring at `Unknown method: skills.marketplace.query`.
 *
 * So: probe a small set of RPCs introduced alongside user-visible features
 * and restart when one is missing. Keep this list short — every entry is
 * one round-trip on connect, and only methods that are *unconditionally*
 * registered belong here (a method behind a feature flag would cause a
 * restart loop).
 */
export const REQUIRED_DAEMON_METHODS: readonly string[] = ["skills.marketplace.query"];
// NOTE: `marketplace.sources.*` (plugin-marketplace source management) was
// implemented then rolled back — the plugin marketplace is deferred until
// MusePi's plugin system settles (it may be reworked wholesale). If it
// ships, re-add "marketplace.sources.list" here and the 4 daemon RPCs.

/**
 * Given the set of methods the daemon actually answered, return the ones it
 * is missing. An empty result means the daemon is current.
 *
 * `answered` must contain only methods that returned a result — a method
 * that errored for any other reason is not evidence of presence, but it is
 * also not evidence of absence; callers should record a probe as
 * "answered" only on success.
 */
export function missingDaemonMethods(answered: Iterable<string>): string[] {
	const have = new Set(answered);
	return REQUIRED_DAEMON_METHODS.filter(m => !have.has(m));
}

/** True when a capability probe says the daemon needs a restart. */
export function shouldRestartForMissingMethods(answered: Iterable<string>): boolean {
	return missingDaemonMethods(answered).length > 0;
}
