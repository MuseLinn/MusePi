/**
 * Build-script approval for plugin installs (bun flavor).
 *
 * Mechanism, verified against bun 1.4.2 (probe 2026-10-15, `bun add` in a
 * scratch project):
 *
 * - A plugins project whose `package.json` has NO `trustedDependencies`
 *   field runs every dependency lifecycle script silently — including a
 *   dragged-in plugin's transitive `postinstall`. The field's presence flips
 *   bun to allowlist mode: only listed packages run scripts, everything else
 *   is blocked with `Blocked N postinstall` (exit code stays 0).
 * - `bun pm untrusted` lists the currently blocked scripts, one package per
 *   entry: `<path>/node_modules/<name> @<version>` followed by
 *   ` » [<hook>]: <command>` lines.
 *
 * So the approval loop is: default-deny (`trustedDependencies: []` on the
 * plugins project) → install → `bun pm untrusted` → surface the blocked
 * names (`pendingBuilds`) → retry with `approvedBuilds`, which merges the
 * names into `trustedDependencies` and reinstalls. Approval persists in the
 * manifest; a failed install never revokes a granted approval (the grant is
 * written before the rollback snapshot is taken).
 *
 * This mirrors dsh's pnpm `allowBuilds` flow in shape, but bun never fails
 * the install for blocked scripts (pnpm exits non-zero with
 * `ERR_PNPM_IGNORED_BUILDS`) — hence detection is a post-install probe
 * rather than a failure classifier.
 */

// SGR color sequences, as an explicit escape so no control byte is needed.
const ANSI_SGR_SOURCE = "\\u001b\\[[0-9;]*m";

/** Parse `bun pm untrusted` output into blocked dependency names. */
export function parseBlockedBuilds(output: string): string[] {
	const names: string[] = [];
	const sgr = new RegExp(ANSI_SGR_SOURCE, "g");
	for (const rawLine of output.split("\n")) {
		// Bun colorizes when stderr is a TTY; strip SGR sequences first.
		const line = rawLine.replace(sgr, "").trimEnd();
		const match = /node_modules[\\/](.+?)\s+@(\S+)\s*$/.exec(line);
		if (!match) continue;
		const name = match[1].trim();
		if (name !== "" && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * Ensure a `trustedDependencies` array exists on a parsed package.json.
 *
 * A missing field means bun runs every script silently; a malformed one
 * makes bun refuse the project outright. Both become `[]` (default-deny).
 * Returns whether the object was changed.
 */
export function ensureTrustedField(pkg: Record<string, unknown>): boolean {
	const current = pkg.trustedDependencies;
	if (Array.isArray(current) && current.every(entry => typeof entry === "string")) {
		return false;
	}
	pkg.trustedDependencies = Array.isArray(current)
		? current.filter((entry): entry is string => typeof entry === "string")
		: [];
	return true;
}

/**
 * Merge approved build names into `trustedDependencies`, preserving existing
 * entries and order. Returns the names actually added.
 */
export function withApprovedBuilds(pkg: Record<string, unknown>, approved: readonly string[]): string[] {
	if (!Array.isArray(pkg.trustedDependencies)) {
		pkg.trustedDependencies = [];
	}
	const list = pkg.trustedDependencies as unknown[];
	const have = new Set(list.filter((entry): entry is string => typeof entry === "string"));
	const added: string[] = [];
	for (const raw of approved) {
		const name = raw.trim();
		if (name === "" || have.has(name)) continue;
		have.add(name);
		(list as string[]).push(name);
		added.push(name);
	}
	return added;
}
