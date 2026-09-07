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
