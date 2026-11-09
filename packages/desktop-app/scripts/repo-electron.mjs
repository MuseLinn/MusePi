/**
 * Identify Electron processes that belong to THIS checkout.
 *
 * Anchor on the script's own repository root. An earlier version hard-coded
 * the upstream sibling directory name, so a renamed or copied fork matched
 * nothing: every relaunch stacked another window on the stale build and every
 * dev start was blocked by the single-instance lock. Unrelated apps (Kimi, an
 * installed MusePi) are never touched.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const normalizePath = value => value.replace(/\//g, "\\").toLowerCase();
const REPO_PREFIX = `${normalizePath(repoRoot)}\\`;
// Per-platform layout: macOS runs from the .app bundle, Windows/Linux from
// electron/dist/electron(.exe). The dependency may live directly under any
// workspace package's node_modules or in bun's .bun store.
const ELECTRON_TAIL =
	/node_modules[\\/](?:\.bun[\\/]electron@[^/\\]+[\\/]node_modules[\\/])?electron[\\/]dist[\\/](electron(\.exe)?|electron\.app[\\/]contents[\\/]macos[\\/]electron)$/;

export function isRepoElectronPath(candidate) {
	const normalized = normalizePath(candidate);
	return normalized.startsWith(REPO_PREFIX) && ELECTRON_TAIL.test(normalized);
}

/** PIDs of Electron processes started from this checkout; empty when the platform lookup fails. */
export function repoElectronPids() {
	const pids = [];
	try {
		if (process.platform === "win32") {
			// tasklist has no command line; PowerShell CIM is the supported route.
			// Lines: "<pid>\t<executable path>".
			const out = execFileSync(
				"powershell",
				[
					"-NoProfile",
					"-Command",
					"Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath } | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }",
				],
				{ encoding: "utf8" },
			);
			for (const line of out.split(/\r?\n/)) {
				const [pidStr, ...rest] = line.split("\t");
				if (rest.length === 0 || !isRepoElectronPath(rest.join("\t"))) continue;
				const pid = Number.parseInt(pidStr, 10);
				if (Number.isFinite(pid)) pids.push(pid);
			}
			return pids;
		}
		const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
		for (const line of out.split("\n")) {
			if (!isRepoElectronPath(line)) continue;
			const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10);
			if (Number.isFinite(pid)) pids.push(pid);
		}
	} catch {
		// Enumeration failure is not fatal: callers sweep what they can and
		// the single-instance lock still protects a running instance.
	}
	return pids;
}
