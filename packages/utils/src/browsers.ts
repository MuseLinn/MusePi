/** Behavior-compatible reimplementation of @puppeteer/browsers' used surface. */

import type * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

const CHROME_FOR_TESTING_BASE_URL = "https://storage.googleapis.com/chrome-for-testing-public";
const CHROME_METADATA_BASE_URL = "https://googlechromelabs.github.io/chrome-for-testing";
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DIRECTORY_MODE = 0o040000;
const ZIP_REGULAR_FILE_MODE = 0o100000;
const ZIP_SYMLINK_MODE = 0o120000;
const ZIP_FILE_TYPE_MASK = 0o170000;

/** Supported browser products. */
export enum Browser {
	CHROME = "chrome",
	CHROMEHEADLESSSHELL = "chrome-headless-shell",
	CHROMIUM = "chromium",
	FIREFOX = "firefox",
	CHROMEDRIVER = "chromedriver",
}

/** Browser download platform identifiers. */
export enum BrowserPlatform {
	LINUX = "linux",
	LINUX_ARM = "linux_arm",
	MAC = "mac",
	MAC_ARM = "mac_arm",
	WIN32 = "win32",
	WIN64 = "win64",
}

const BROWSERS = [
	Browser.CHROME,
	Browser.CHROMEHEADLESSSHELL,
	Browser.CHROMIUM,
	Browser.FIREFOX,
	Browser.CHROMEDRIVER,
] as const;
const BROWSER_PLATFORMS = [
	BrowserPlatform.LINUX,
	BrowserPlatform.LINUX_ARM,
	BrowserPlatform.MAC,
	BrowserPlatform.MAC_ARM,
	BrowserPlatform.WIN32,
	BrowserPlatform.WIN64,
] as const;

/** Chrome-for-Testing release channel tags accepted by {@link resolveBuildId}. */
export enum BrowserTag {
	CANARY = "canary",
	NIGHTLY = "nightly",
	BETA = "beta",
	DEV = "dev",
	DEVEDITION = "devedition",
	STABLE = "stable",
	ESR = "esr",
	LATEST = "latest",
}

/** Download progress reported while a browser archive is streamed to disk. */
export interface BrowserDownloadProgress {
	downloadedBytes: number;
	totalBytes: number;
}

/** Inputs used to locate an installed browser executable. */
export interface ComputeExecutablePathOptions {
	browser: Browser;
	buildId: string;
	cacheDir: string;
	platform?: BrowserPlatform;
}

/** Inputs used to download and install a browser. */
export interface InstallOptions extends ComputeExecutablePathOptions {
	baseUrl?: string;
	downloadProgressCallback?: (progress: BrowserDownloadProgress) => void;
}

/** Metadata for one browser installation found in a Puppeteer cache. */
export interface InstalledBrowser {
	browser: Browser;
	buildId: string;
	platform: BrowserPlatform;
	path: string;
	executablePath: string;
}

interface LastKnownGoodVersions {
	channels: Record<string, { version: string }>;
}

interface MilestoneVersions {
	milestones: Record<string, { version: string }>;
}

interface PatchVersions {
	builds: Record<string, { version: string }>;
}

interface ZipEntry {
	name: string;
	method: number;
	crc: number;
	compressedSize: number;
	uncompressedSize: number;
	externalAttributes: number;
	localHeaderOffset: number;
}

/** Detect the current host's Puppeteer browser platform. */
export function detectBrowserPlatform(): BrowserPlatform | undefined {
	const platform = os.platform();
	const arch = os.arch();
	if (platform === "darwin") return arch === "arm64" ? BrowserPlatform.MAC_ARM : BrowserPlatform.MAC;
	if (platform === "linux") return arch === "arm64" ? BrowserPlatform.LINUX_ARM : BrowserPlatform.LINUX;
	if (platform === "win32") return arch === "ia32" ? BrowserPlatform.WIN32 : BrowserPlatform.WIN64;
	return undefined;
}

/** Resolve a Chrome-for-Testing channel, milestone, or build prefix to a full build ID. */
export async function resolveBuildId(
	browser: Browser,
	_platform: BrowserPlatform,
	tag: string | BrowserTag,
): Promise<string> {
	if (browser !== Browser.CHROME && browser !== Browser.CHROMEHEADLESSSHELL && browser !== Browser.CHROMEDRIVER) {
		return tag;
	}
	if (/^\d+\.\d+\.\d+\.\d+$/.test(tag)) return tag;

	const channel = tag === BrowserTag.LATEST ? "Canary" : chromeChannelName(tag);
	if (channel) {
		const metadata = await fetchMetadata<LastKnownGoodVersions>("last-known-good-versions.json");
		const version = metadata.channels[channel]?.version;
		if (!version) throw new Error(`Chrome channel ${tag} was not found in Chrome-for-Testing metadata`);
		return version;
	}
	if (/^\d+$/.test(tag)) {
		const metadata = await fetchMetadata<MilestoneVersions>("latest-versions-per-milestone.json");
		return metadata.milestones[tag]?.version ?? tag;
	}
	if (/^\d+\.\d+\.\d+$/.test(tag)) {
		const metadata = await fetchMetadata<PatchVersions>("latest-patch-versions-per-build.json");
		return metadata.builds[tag]?.version ?? tag;
	}
	return tag;
}

/** Return the Chrome-for-Testing archive URL for a browser build. */
export function getDownloadUrl(
	browser: Browser,
	platform: BrowserPlatform,
	buildId: string,
	baseUrl = CHROME_FOR_TESTING_BASE_URL,
): URL {
	if (browser !== Browser.CHROME) throw new Error(`Unsupported browser download: ${browser}`);
	const archivePlatform = chromeArchivePlatform(platform);
	const root = baseUrl.replace(/\/$/, "");
	return new URL(`${root}/${buildId}/${archivePlatform}/chrome-${archivePlatform}.zip`);
}

/** Compute the executable path in Puppeteer's cache layout. */
export function computeExecutablePath(options: ComputeExecutablePathOptions): string {
	const platform = options.platform ?? detectBrowserPlatform();
	if (!platform) throw new Error("Cannot determine a browser platform for this host");
	if (options.browser !== Browser.CHROME) throw new Error(`Unsupported browser executable: ${options.browser}`);
	const installDir = installationDir(options.cacheDir, options.browser, platform, options.buildId);
	switch (platform) {
		case BrowserPlatform.LINUX:
		case BrowserPlatform.LINUX_ARM:
			return path.join(installDir, "chrome-linux64", "chrome");
		case BrowserPlatform.MAC:
			return path.join(
				installDir,
				"chrome-mac-x64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case BrowserPlatform.MAC_ARM:
			return path.join(
				installDir,
				"chrome-mac-arm64",
				"Google Chrome for Testing.app",
				"Contents",
				"MacOS",
				"Google Chrome for Testing",
			);
		case BrowserPlatform.WIN32:
			return path.join(installDir, "chrome-win32", "chrome.exe");
		case BrowserPlatform.WIN64:
			return path.join(installDir, "chrome-win64", "chrome.exe");
	}
}

/** Scan a Puppeteer cache for browser installation directories. */
export async function getInstalledBrowsers(options: { cacheDir: string }): Promise<InstalledBrowser[]> {
	const installed: InstalledBrowser[] = [];
	for (const browser of BROWSERS) {
		const browserDir = path.join(options.cacheDir, browser);
		let entries: fs.Dirent[];
		try {
			entries = await fsp.readdir(browserDir, { withFileTypes: true });
		} catch (error) {
			if (isMissingPath(error)) continue;
			throw error;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const parsed = parseInstallationName(entry.name);
			if (!parsed) continue;
			const installPath = path.join(browserDir, entry.name);
			try {
				installed.push({
					browser,
					buildId: parsed.buildId,
					platform: parsed.platform,
					path: installPath,
					executablePath: computeExecutablePath({
						browser,
						buildId: parsed.buildId,
						cacheDir: options.cacheDir,
						platform: parsed.platform,
					}),
				});
			} catch {
				// Other browser products are not part of the surface used by OMP.
			}
		}
	}
	return installed;
}

/** Download and unpack Chrome into Puppeteer's existing cache layout. */
export async function install(options: InstallOptions): Promise<InstalledBrowser> {
	const platform = options.platform ?? detectBrowserPlatform();
	if (!platform) throw new Error("Cannot determine a browser platform for this host");
	const executablePath = computeExecutablePath({ ...options, platform });
	const installPath = installationDir(options.cacheDir, options.browser, platform, options.buildId);
	if (await pathExists(executablePath)) {
		return { browser: options.browser, buildId: options.buildId, platform, path: installPath, executablePath };
	}

	await fsp.mkdir(options.cacheDir, { recursive: true });
	const nonce = `${process.pid}-${crypto.randomUUID()}`;
	const archivePath = path.join(options.cacheDir, `.browser-${nonce}.zip`);
	const stagingPath = path.join(options.cacheDir, `.browser-${nonce}`);
	try {
		await downloadArchive(
			getDownloadUrl(options.browser, platform, options.buildId, options.baseUrl),
			archivePath,
			options.downloadProgressCallback,
		);
		await extractZipArchive(archivePath, stagingPath);
		await fsp.mkdir(path.dirname(installPath), { recursive: true });
		await fsp.rm(installPath, { recursive: true, force: true });
		await fsp.rename(stagingPath, installPath);
	} finally {
		await Promise.all([
			fsp.rm(archivePath, { force: true }).catch(() => {}),
			fsp.rm(stagingPath, { recursive: true, force: true }).catch(() => {}),
		]);
	}
	if (!(await pathExists(executablePath)))
		throw new Error(`Browser archive did not contain its expected executable: ${executablePath}`);
	return { browser: options.browser, buildId: options.buildId, platform, path: installPath, executablePath };
}

function chromeChannelName(tag: string): string | undefined {
	switch (tag) {
		case BrowserTag.STABLE:
			return "Stable";
		case BrowserTag.BETA:
			return "Beta";
		case BrowserTag.DEV:
			return "Dev";
		case BrowserTag.CANARY:
			return "Canary";
		default:
			return undefined;
	}
}

async function fetchMetadata<T>(filename: string): Promise<T> {
	const response = await fetch(`${CHROME_METADATA_BASE_URL}/${filename}`);
	if (!response.ok)
		throw new Error(`Failed to fetch Chrome-for-Testing metadata (${response.status} ${response.statusText})`);
	return (await response.json()) as T;
}

function chromeArchivePlatform(platform: BrowserPlatform): string {
	switch (platform) {
		case BrowserPlatform.LINUX:
		case BrowserPlatform.LINUX_ARM:
			return "linux64";
		case BrowserPlatform.MAC:
			return "mac-x64";
		case BrowserPlatform.MAC_ARM:
			return "mac-arm64";
		case BrowserPlatform.WIN32:
			return "win32";
		case BrowserPlatform.WIN64:
			return "win64";
	}
}

function installationDir(cacheDir: string, browser: Browser, platform: BrowserPlatform, buildId: string): string {
	return path.join(cacheDir, browser, `${platform}-${buildId}`);
}

function parseInstallationName(name: string): { platform: BrowserPlatform; buildId: string } | undefined {
	for (const platform of BROWSER_PLATFORMS) {
		const prefix = `${platform}-`;
		if (name.startsWith(prefix) && name.length > prefix.length)
			return { platform, buildId: name.slice(prefix.length) };
	}
	return undefined;
}

function isMissingPath(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fsp.access(filePath);
		return true;
	} catch (error) {
		if (isMissingPath(error)) return false;
		throw error;
	}
}

async function downloadArchive(
	url: URL,
	destination: string,
	onProgress: ((progress: BrowserDownloadProgress) => void) | undefined,
): Promise<void> {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`Browser download failed (${response.status} ${response.statusText}) from ${url}`);
	}
	const totalBytes = Number(response.headers.get("content-length") ?? 0);
	const file = await fsp.open(destination, "wx");
	let downloadedBytes = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			let offset = 0;
			while (offset < chunk.value.byteLength) {
				const write = await file.write(chunk.value, offset, chunk.value.byteLength - offset, null);
				if (write.bytesWritten === 0) throw new Error(`Browser download stalled while writing ${destination}`);
				offset += write.bytesWritten;
			}
			downloadedBytes += chunk.value.byteLength;
			onProgress?.({ downloadedBytes, totalBytes });
		}
	} finally {
		await file.close();
	}
}

async function extractZipArchive(archivePath: string, destination: string): Promise<void> {
	const archive = await fsp.readFile(archivePath);
	const entries = readCentralDirectory(archive);
	await fsp.mkdir(destination, { recursive: true });
	const root = path.resolve(destination);
	for (const entry of entries) {
		const outputPath = safeArchivePath(root, entry.name);
		const mode = entry.externalAttributes >>> 16;
		const type = mode & ZIP_FILE_TYPE_MASK;
		if (entry.name.endsWith("/") || type === ZIP_DIRECTORY_MODE) {
			await fsp.mkdir(outputPath, { recursive: true });
			if (mode & 0o777) await fsp.chmod(outputPath, mode & 0o777);
			continue;
		}

		const contents = readZipEntry(archive, entry);
		await fsp.mkdir(path.dirname(outputPath), { recursive: true });
		if (type === ZIP_SYMLINK_MODE) {
			const target = contents.toString("utf8");
			validateSymlinkTarget(root, outputPath, target);
			await fsp.symlink(target, outputPath);
			continue;
		}
		await fsp.writeFile(outputPath, contents, { mode: mode & 0o777 ? mode & 0o777 : 0o644 });
		if ((mode & ZIP_FILE_TYPE_MASK) === ZIP_REGULAR_FILE_MODE && mode & 0o777)
			await fsp.chmod(outputPath, mode & 0o777);
	}
}

function readCentralDirectory(archive: Buffer): ZipEntry[] {
	const minimumOffset = Math.max(0, archive.length - 65_557);
	let endOffset = -1;
	for (let offset = archive.length - 22; offset >= minimumOffset; offset--) {
		if (archive.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
			endOffset = offset;
			break;
		}
	}
	if (endOffset < 0) throw new Error("Invalid ZIP archive: central directory was not found");
	const disk = archive.readUInt16LE(endOffset + 4);
	const centralDisk = archive.readUInt16LE(endOffset + 6);
	const entryCount = archive.readUInt16LE(endOffset + 10);
	const centralSize = archive.readUInt32LE(endOffset + 12);
	const centralOffset = archive.readUInt32LE(endOffset + 16);
	if (disk !== 0 || centralDisk !== 0) throw new Error("Multi-disk ZIP archives are not supported");
	if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
		throw new Error("ZIP64 archives are not supported");
	}
	if (centralOffset + centralSize > endOffset)
		throw new Error("Invalid ZIP archive: central directory is out of bounds");

	const entries: ZipEntry[] = [];
	let offset = centralOffset;
	for (let index = 0; index < entryCount; index++) {
		if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
			throw new Error("Invalid ZIP archive: malformed central directory entry");
		}
		const flags = archive.readUInt16LE(offset + 8);
		if (flags & 1) throw new Error("Encrypted ZIP entries are not supported");
		const nameLength = archive.readUInt16LE(offset + 28);
		const extraLength = archive.readUInt16LE(offset + 30);
		const commentLength = archive.readUInt16LE(offset + 32);
		const end = offset + 46 + nameLength + extraLength + commentLength;
		if (end > archive.length) throw new Error("Invalid ZIP archive: truncated central directory entry");
		entries.push({
			name: archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"),
			method: archive.readUInt16LE(offset + 10),
			crc: archive.readUInt32LE(offset + 16),
			compressedSize: archive.readUInt32LE(offset + 20),
			uncompressedSize: archive.readUInt32LE(offset + 24),
			externalAttributes: archive.readUInt32LE(offset + 38),
			localHeaderOffset: archive.readUInt32LE(offset + 42),
		});
		offset = end;
	}
	return entries;
}

function readZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
	const offset = entry.localHeaderOffset;
	if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== ZIP_LOCAL_FILE_HEADER) {
		throw new Error(`Invalid ZIP archive: malformed local header for ${entry.name}`);
	}
	const nameLength = archive.readUInt16LE(offset + 26);
	const extraLength = archive.readUInt16LE(offset + 28);
	const start = offset + 30 + nameLength + extraLength;
	const end = start + entry.compressedSize;
	if (end > archive.length) throw new Error(`Invalid ZIP archive: truncated data for ${entry.name}`);
	const compressed = archive.subarray(start, end);
	let contents: Buffer;
	if (entry.method === 0) contents = Buffer.from(compressed);
	else if (entry.method === 8) contents = zlib.inflateRawSync(compressed);
	else throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
	if (contents.length !== entry.uncompressedSize)
		throw new Error(`Invalid uncompressed size for ZIP entry ${entry.name}`);
	if (crc32(contents) !== entry.crc) throw new Error(`CRC mismatch for ZIP entry ${entry.name}`);
	return contents;
}

function safeArchivePath(root: string, name: string): string {
	if (!name || name.includes("\0") || name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) {
		throw new Error(`Unsafe path in ZIP archive: ${name}`);
	}
	const segments = name.replaceAll("\\", "/").split("/");
	if (segments.some(segment => segment === "..")) throw new Error(`Unsafe path in ZIP archive: ${name}`);
	const target = path.resolve(root, ...segments.filter(Boolean));
	if (target !== root && !target.startsWith(`${root}${path.sep}`))
		throw new Error(`Unsafe path in ZIP archive: ${name}`);
	return target;
}

function validateSymlinkTarget(root: string, linkPath: string, target: string): void {
	if (!target || target.includes("\0") || path.isAbsolute(target) || /^[A-Za-z]:/.test(target)) {
		throw new Error(`Unsafe symlink target in ZIP archive: ${target}`);
	}
	const resolved = path.resolve(path.dirname(linkPath), target);
	if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error(`Unsafe symlink target in ZIP archive: ${target}`);
	}
}

function crc32(contents: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of contents) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
