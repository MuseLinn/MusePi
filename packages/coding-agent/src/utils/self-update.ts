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
 * - Windows: the directory of a running exe cannot be renamed, but the exe
 *   file itself *can* be renamed (NTFS remaps the file handle to the new
 *   name). The swap happens in-process without needing a helper process:
 *   copy non-exe files from the staged dir (best-effort, skip locked files),
 *   rename the running exe to `<name>.<ts>.bak`, copy the new exe in place,
 *   and verify with `--version`. The `.bak` is cleaned up on the next
 *   successful update.
 *
 * On both platforms the previous install artifact is preserved until the
 * next successful self-update (which proves the new install works).
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

export interface WindowsApplyOptions {
	installDir: string;
	stagedDir: string;
	platform: NodeJS.Platform;
	suffix?: string;
	verify?: VerifyInstall;
}

/**
 * Walk the staged dir recursively and copy non-exe files to the install dir.
 * Files that are locked by the running process (EBUSY/EACCES) are skipped;
 * they will be replaced on the next update.
 */
function syncCopyStagedDir(src: string, dst: string, exeName: string): void {
	mkdirSync(dst, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		const srcPath = join(src, entry.name);
		const dstPath = join(dst, entry.name);
		if (entry.isDirectory()) {
			syncCopyStagedDir(srcPath, dstPath, exeName);
		} else if (entry.isFile() && entry.name !== exeName) {
			try {
				cpSync(srcPath, dstPath, { force: true });
			} catch {
				// File may be locked by the running process; skip and try
				// again on the next update.
			}
		}
	}
}

/**
 * Remove leftover `.ps1` scripts and `.log` files from the old PS-based
 * Windows update approach that required process.exit().
 */
export function cleanupStaleWindowsUpdateScripts(installDir: string): void {
	const parent = dirname(installDir);
	const prefix = basename(installDir);
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(`${prefix}.update-`)) continue;
		try {
			rmSync(join(parent, entry), { force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
}

/**
 * Best-effort removal of `<exe>.*.bak` backup files from earlier Windows
 * updates. On Windows a backup cannot be deleted while the updating process
 * is alive (it IS the running process image after the rename), so it is
 * left for a later run to reclaim.
 */
export function sweepStaleWindowsBackups(installDir: string, exeName: string): void {
	let entries: string[];
	try {
		entries = readdirSync(installDir);
	} catch {
		return;
	}
	const bakPattern = `${exeName}.`;
	for (const entry of entries) {
		if (!entry.startsWith(bakPattern) || !entry.endsWith(".bak")) continue;
		const middle = entry.slice(bakPattern.length, entry.length - ".bak".length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		try {
			rmSync(join(installDir, entry), { force: true });
		} catch {
			// Will try again next update.
		}
	}
}

/**
 * Windows in-place update.
 *
 * On Windows, renaming the directory of a running exe is not allowed, but
 * renaming the exe file itself *is* allowed (NTFS remaps the file handle).
 * This function performs the swap entirely in-process, without needing a
 * helper PowerShell script or process.exit():
 *
 *  1. Copy non-exe files from the staged dir to the install dir, skipping
 *     any files locked by the running process.
 *  2. Rename the running exe to `<exe>.<ts>.bak`.
 *  3. Copy the new exe from the staged dir in place.
 *  4. Verify with `--version`; roll back on failure.
 *  5. Best-effort delete the backup (will fail if still mapped; reclaimed
 *     on the next update via sweepStaleWindowsBackups).
 *  6. Clean up stale `.ps1` scripts from the old PS-based approach.
 */
export async function applyStagedUpdateWindows(options: WindowsApplyOptions): Promise<{ backupExe: string }> {
	const suffix = options.suffix ?? timestampSuffix();
	const verify = options.verify ?? defaultVerifyInstall;
	const exeName = executableNameForPlatform(options.platform);

	// 1. Copy non-exe files (best-effort, skip locked files).
	syncCopyStagedDir(options.stagedDir, options.installDir, exeName);

	const oldExe = join(options.installDir, exeName);
	const backupExe = join(options.installDir, `${exeName}.${suffix}.bak`);
	const newExe = join(options.stagedDir, exeName);

	// 2. Rename the running exe (allowed on Windows).
	try {
		renameSync(oldExe, backupExe);
	} catch (error) {
		throw new Error(`Could not rename running ${exeName} for update: ${error}`);
	}

	// 3. Copy the new exe in place.
	try {
		cpSync(newExe, oldExe);
	} catch (error) {
		// Rollback: put the backup back.
		try {
			renameSync(backupExe, oldExe);
		} catch {
			// Worst case: backup is at backupExe and the install dir has no
			// valid exe. User can recover by re-running the installer.
		}
		throw new Error(`Could not install updated ${exeName}: ${error}`);
	}

	// 4. Verify the new executable.
	if (!(await verify(oldExe))) {
		// Rollback: keep the broken exe for diagnosis, restore the backup.
		try {
			const failedExe = join(options.installDir, `${exeName}.failed-${suffix}`);
			renameSync(oldExe, failedExe);
		} catch {
			// Best-effort.
		}
		try {
			renameSync(backupExe, oldExe);
		} catch {
			// Best-effort.
		}
		throw new Error(`Updated ${exeName} failed its --version check; rolled back to the previous binary.`);
	}

	// 5. Best-effort cleanup of the backup (will fail if still mapped).
	try {
		rmSync(backupExe, { force: true });
	} catch {
		// Cleaned up on the next update via sweepStaleWindowsBackups.
	}

	// 6. Clean up stale .ps1 scripts from the old PS-based approach.
	cleanupStaleWindowsUpdateScripts(options.installDir);

	return { backupExe };
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
 * Render the detached PowerShell swap script used on Windows.
 *
 * @deprecated Replaced by {@link applyStagedUpdateWindows} which performs
 *   the swap in-process via file rename, without needing a helper PS script
 *   or process.exit(). Kept for unit test coverage of the old approach.
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
 * Launch the Windows swap script detached and hidden.
 *
 * @deprecated Replaced by {@link applyStagedUpdateWindows} which performs
 *   the swap in-process via file rename. Kept for backward compatibility
 *   if external code references it.
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
