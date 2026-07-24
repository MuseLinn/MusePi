import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extractTarGzArchive, extractZipArchive } from "./tools-manager.ts";
import type { LatestPiRelease } from "./version-check.ts";

/**
 * MusePi binary self-update.
 *
 * MusePi ships as per-platform GitHub Release archives (not npm), so
 * `musepi update` downloads the archive for the current platform, verifies
 * its shape, and swaps the install directory atomically-ish:
 *
 * - POSIX: a running executable can be renamed/replaced freely, so the swap
 *   happens in-process: rename the install dir to `<name>.old-<ts>`, move the
 *   staged dir into place, run `<exe> --version` to verify, and roll back on
 *   any failure. The `.old` backup is kept until the next successful run.
 * - Windows: a running exe can be renamed but its *directory* cannot be moved
 *   while it is alive, and in-process per-file replacement risks half-written
 *   installs with no clean rollback. Instead the updater stages the new
 *   version in a sibling directory and hands a small PowerShell script the
 *   swap: it waits for this process to exit, renames the install dir to
 *   `<name>.old-<ts>`, moves the staged dir in, verifies `<exe> --version`
 *   into a log file, and rolls the old dir back on failure. The current
 *   process exits right after launching the script.
 *
 * In both cases the previous install is preserved as `<name>.old-<ts>` next
 * to the install dir and is cleaned up by the next successful self-update
 * run (which proves the new install works).
 */

const GITHUB_RELEASE_DOWNLOAD_BASE = "https://github.com/MuseLinn/MusePi/releases/download";
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export interface PlatformKey {
	platform: NodeJS.Platform;
	arch: string;
}

/** Map a Node platform/arch pair to the release archive name, e.g. musepi-windows-x64.zip. */
export function getReleaseAssetName(platform: NodeJS.Platform, arch: string): string | undefined {
	const platformName =
		platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
	const archName = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : undefined;
	if (!platformName || !archName) return undefined;
	const extension = platformName === "windows" ? "zip" : "tar.gz";
	return `musepi-${platformName}-${archName}.${extension}`;
}

/** Pick the release asset matching this platform, falling back to the conventional download URL. */
export function resolveAssetDownload(
	release: LatestPiRelease,
	platform: NodeJS.Platform,
	arch: string,
): { assetName: string; url: string } | undefined {
	const assetName = getReleaseAssetName(platform, arch);
	if (!assetName) return undefined;
	const asset = release.assets?.find((candidate) => candidate.name === assetName);
	const url = asset?.url ?? `${GITHUB_RELEASE_DOWNLOAD_BASE}/v${release.version}/${assetName}`;
	return { assetName, url };
}

export interface InstallRootValidation {
	valid: boolean;
	reason?: string;
	version?: string;
}

export function executableNameForPlatform(platform: NodeJS.Platform): string {
	return platform === "win32" ? "musepi.exe" : "musepi";
}

/**
 * Verify that a directory looks like a MusePi install: it contains the
 * executable and a sibling package.json whose piConfig.name is "musepi"
 * (guards against flashing a wrong archive over the install).
 */
export function validateInstallRoot(dir: string, platform: NodeJS.Platform): InstallRootValidation {
	const executable = join(dir, executableNameForPlatform(platform));
	if (!existsSync(executable)) {
		return { valid: false, reason: `missing executable ${executableNameForPlatform(platform)}` };
	}
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) {
		return { valid: false, reason: "missing package.json next to the executable" };
	}
	let pkg: { piConfig?: { name?: unknown }; version?: unknown };
	try {
		pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as typeof pkg;
	} catch {
		return { valid: false, reason: "package.json is not valid JSON" };
	}
	if (pkg.piConfig?.name !== "musepi") {
		return { valid: false, reason: 'package.json piConfig.name is not "musepi"' };
	}
	return { valid: true, ...(typeof pkg.version === "string" ? { version: pkg.version } : {}) };
}

/**
 * Locate the install root inside an extracted archive. POSIX tarballs wrap
 * everything in a `musepi/` directory; Windows zips carry files at the root.
 */
export function findInstallRoot(extractDir: string, platform: NodeJS.Platform): string | undefined {
	if (validateInstallRoot(extractDir, platform).valid) {
		return extractDir;
	}
	for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = join(extractDir, entry.name);
		if (validateInstallRoot(candidate, platform).valid) {
			return candidate;
		}
	}
	return undefined;
}

/** Derive the install directory from the running executable path and sanity-check it. */
export function detectInstallDir(execPath: string, platform: NodeJS.Platform): string | undefined {
	const dir = dirname(execPath);
	return validateInstallRoot(dir, platform).valid ? dir : undefined;
}

/** Probe whether a directory accepts new files (used for the parent of the install dir). */
export function isDirectoryWritable(dir: string): boolean {
	const probe = join(dir, `.musepi-write-probe-${process.pid}-${Date.now()}`);
	try {
		writeFileSync(probe, "");
		rmSync(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

export function timestampSuffix(now: number = Date.now()): string {
	return String(now);
}

export function stagedDirName(installDir: string, suffix: string): string {
	return join(dirname(installDir), `${basename(installDir)}.new-${suffix}`);
}

export function backupDirName(installDir: string, suffix: string): string {
	return join(dirname(installDir), `${basename(installDir)}.old-${suffix}`);
}

/**
 * Remove leftover `<name>.old-*` backups and `<name>.new-*` staging dirs from
 * previous updates. Called when a new update run starts, which only happens
 * on a working install, so the backups have served their purpose.
 */
export function cleanupStaleUpdateDirs(installDir: string): string[] {
	const parent = dirname(installDir);
	const prefix = basename(installDir);
	const removed: string[] = [];
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!entry.name.startsWith(`${prefix}.old-`) && !entry.name.startsWith(`${prefix}.new-`)) continue;
		const target = join(parent, entry.name);
		rmSync(target, { recursive: true, force: true });
		removed.push(target);
	}
	return removed;
}

/** Download an archive with byte progress reporting. */
export async function downloadReleaseAsset(
	url: string,
	dest: string,
	onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void,
): Promise<void> {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
	}
	if (!response.body) {
		throw new Error("Download failed: empty response body");
	}
	const contentLength = Number(response.headers.get("content-length"));
	const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : undefined;
	let received = 0;
	const counter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			received += chunk.length;
			onProgress?.(received, total);
			callback(null, chunk);
		},
	});
	await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(dest));
}

/** Extract a release archive (zip or tar.gz) into the given directory. */
export function extractReleaseArchive(archivePath: string, extractDir: string, assetName: string): void {
	mkdirSync(extractDir, { recursive: true });
	if (assetName.endsWith(".tar.gz")) {
		extractTarGzArchive(archivePath, extractDir, assetName);
	} else if (assetName.endsWith(".zip")) {
		extractZipArchive(archivePath, extractDir, assetName);
	} else {
		throw new Error(`Unsupported archive format: ${assetName}`);
	}
}

/** Create a fresh temporary work directory for downloads/extraction. */
export function createUpdateWorkDir(): string {
	return mkdtempSync(join(tmpdir(), "musepi-update-"));
}

/**
 * Copy the validated install root into a sibling staging directory of the
 * current install (same volume, so the final rename into place is atomic).
 */
export function stageInstallRoot(installRoot: string, installDir: string, suffix: string): string {
	const stagedDir = stagedDirName(installDir, suffix);
	rmSync(stagedDir, { recursive: true, force: true });
	cpSync(installRoot, stagedDir, { recursive: true });
	return stagedDir;
}

export type VerifyInstall = (executablePath: string) => boolean | Promise<boolean>;

/** Default post-swap verification: the new executable must answer `--version`. */
export const defaultVerifyInstall: VerifyInstall = (executablePath) => {
	const result = spawnSync(executablePath, ["--version"], { timeout: 15000, stdio: "pipe" });
	return !result.error && result.status === 0;
};

export interface PosixApplyOptions {
	installDir: string;
	stagedDir: string;
	platform: NodeJS.Platform;
	suffix?: string;
	verify?: VerifyInstall;
}

/**
 * POSIX swap: rename the live install aside, move the staged dir in, verify,
 * and roll back on failure. Renaming a directory that contains the running
 * executable is legal on POSIX, so no helper process is needed.
 */
export async function applyStagedUpdatePosix(options: PosixApplyOptions): Promise<{ backupDir: string }> {
	const suffix = options.suffix ?? timestampSuffix();
	const verify = options.verify ?? defaultVerifyInstall;
	const backupDir = backupDirName(options.installDir, suffix);
	rmSync(backupDir, { recursive: true, force: true });

	renameSync(options.installDir, backupDir);
	try {
		renameSync(options.stagedDir, options.installDir);
	} catch (error) {
		renameSync(backupDir, options.installDir);
		throw error;
	}

	const executable = join(options.installDir, executableNameForPlatform(options.platform));
	if (options.platform !== "win32") {
		chmodSync(executable, 0o755);
	}
	if (await verify(executable)) {
		return { backupDir };
	}

	// Verification failed: roll back and keep the broken attempt for diagnosis.
	const failedDir = join(dirname(options.installDir), `${basename(options.installDir)}.failed-${suffix}`);
	rmSync(failedDir, { recursive: true, force: true });
	renameSync(options.installDir, failedDir);
	renameSync(backupDir, options.installDir);
	throw new Error(
		`Updated MusePi failed its --version check; rolled back to the previous install (${failedDir} kept).`,
	);
}

export interface WindowsUpdateScriptOptions {
	installDir: string;
	stagedDir: string;
	backupDir: string;
	logFile: string;
	parentPid: number;
}

function psLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render the detached PowerShell swap script used on Windows. The script is
 * generated (not executed) by the running process, which makes it unit
 * testable; it is launched only after the user confirms the update.
 */
export function buildWindowsUpdateScript(options: WindowsUpdateScriptOptions): string {
	const installDir = psLiteral(options.installDir);
	const stagedDir = psLiteral(options.stagedDir);
	const backupDir = psLiteral(options.backupDir);
	const logFile = psLiteral(options.logFile);
	return `$ErrorActionPreference = 'Stop'
$installDir = ${installDir}
$stagedDir = ${stagedDir}
$backupDir = ${backupDir}
$logFile = ${logFile}
$parentPid = ${options.parentPid}

function Log([string] $message) {
	Add-Content -LiteralPath $logFile -Value ("[{0}] {1}" -f (Get-Date -Format 'o'), $message)
}

# Wait (bounded) for the calling musepi process to release the install dir.
$deadline = (Get-Date).AddSeconds(120)
while ($true) {
	$running = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
	if (-not $running) { break }
	if ((Get-Date) -gt $deadline) {
		Log "musepi (PID $parentPid) did not exit in time; aborting update"
		exit 1
	}
	Start-Sleep -Milliseconds 500
}

try {
	Move-Item -LiteralPath $installDir -Destination $backupDir
	try {
		Move-Item -LiteralPath $stagedDir -Destination $installDir
	} catch {
		# Put the old install back before reporting the failure.
		Move-Item -LiteralPath $backupDir -Destination $installDir
		throw
	}
	$exe = Join-Path $installDir 'musepi.exe'
	$versionOutput = (& $exe --version 2>&1 | Out-String).Trim()
	if ($LASTEXITCODE -ne 0) { throw "musepi.exe --version exited with $LASTEXITCODE" }
	Log "Updated MusePi: $versionOutput (previous install kept at $backupDir)"
} catch {
	Log ("Update failed: " + $_.Exception.Message)
	exit 1
}

Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;
}

/**
 * Launch the Windows swap script detached and hidden. The caller must exit
 * the current process immediately afterwards so the script can do the swap.
 */
export function launchWindowsUpdateScript(scriptPath: string): void {
	// Resolve the full path: powershell.exe is not guaranteed on PATH for
	// spawned children (System32\WindowsPowerShell always exists on supported
	// Windows versions).
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	const powershell = systemRoot
		? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		: "powershell.exe";
	const child = spawn(
		powershell,
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
		{ detached: true, stdio: "ignore", windowsHide: true },
	);
	child.on("error", () => {});
	child.unref();
}
