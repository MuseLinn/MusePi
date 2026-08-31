/**
 * Update CLI command handler.
 *
 * Handles `musepi update` to check for and install updates.
 * Uses the installer that owns the active musepi executable when it can be detected.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { $env, $which, APP_NAME, compareVersions, isEnoent, VERSION } from "@musepi/pi-utils";
import chalk from "@musepi/pi-utils/chalk";
import { withFileLock } from "@musepi/pi-utils/file-lock";
import { $ } from "bun";
import { theme } from "../modes/theme/theme";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";

const REPO = "MuseLinn/MusePi";
const PACKAGE = "@musepi/pi-coding-agent";
const HOMEBREW_FORMULA = "MuseLinn/tap/MusePi";
const MISE_TOOL = "github:MuseLinn/MusePi";
const NIX_STORE_DIR = "/nix/store";
/**
 * Official npm registry origin.
 *
 * Pinned across both the version check and the bun install step so the two
 * agree on which catalog they are talking to. A user's bun may be pointed at
 * an unofficial mirror (corporate proxy, Taobao, etc.) that lags the upstream
 * registry by minutes-to-hours, in which case `getLatestRelease` would resolve
 * a version the mirror has not yet replicated and the install would fail with
 * `No version matching "X" found for specifier "<pkg>" (but package exists)`.
 * See #1686.
 */
const NPM_REGISTRY = "https://registry.npmjs.org/";
const GITHUB_API = "https://api.github.com";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;
const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

/**
 * Core native addon package. Bumped in lock-step with {@link PACKAGE} so the
 * version sentinel the loader looks up at runtime matches the `.node` on
 * disk; see {@link buildBunInstallArgs} for why this must be installed
 * explicitly rather than inherited as a transitive dependency.
 */
const NATIVES_PACKAGE = "@musepi/pi-natives";

/**
 * Platform tags the release pipeline publishes as
 * `@musepi/pi-natives-<tag>` leaves. Mirrors `SUPPORTED_PLATFORMS` in
 * `packages/natives/native/loader-state.js` and `LEAF_TARGETS` in
 * `packages/natives/scripts/gen-npm-packages.ts`; kept here as the local
 * source of truth so the update path stays free of cross-package imports.
 */
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

/** Distribution channel advertised by a release's published npm manifest. */
export type ReleaseDist = "npm" | "binary";

/** npm package names a release installs: the agent package and its natives companion. */
export interface ReleasePackages {
	pkg: string;
	natives: string;
}

/** Parsed `musepi.rename` pointer: the new agent package name and optional new natives name. */
export interface ReleaseRename {
	pkg: string;
	natives?: string;
}

const CURRENT_PACKAGES: ReleasePackages = { pkg: PACKAGE, natives: NATIVES_PACKAGE };

export interface ReleaseInfo {
	tag: string;
	version: string;
	/** Parsed `musepi.dist` from the registry manifest; undefined when absent. */
	dist?: ReleaseDist;
	/** npm names to install, resolved after following any `musepi.rename` pointers. */
	packages: ReleasePackages;
}

export interface ReleaseBinaryAsset {
	url: string;
	size: number;
	digest: string;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Parse the distribution-mode field from a published package manifest.
 *
 * Forward-compatibility contract with future releases: a release that is not
 * installable as an npm package (e.g. a native rewrite) publishes
 * `"musepi": { "dist": "binary" }` in its package.json. Any value other than
 * "npm" — including values this updater does not know yet — maps to "binary"
 * so already-deployed updaters never run a package-manager install against a
 * release that no longer supports it.
 */
export function resolveReleaseDist(manifest: unknown): ReleaseDist | undefined {
	if (!isRecord(manifest) || !isRecord(manifest.musepi)) return undefined;
	const dist = manifest.musepi.dist;
	if (dist === undefined) return undefined;
	return dist === "npm" ? "npm" : "binary";
}

/**
 * Parse the package-rename pointer from a published package manifest.
 *
 * Forward-compatibility contract for renaming the npm package: the final
 * version published under an old name is a stub whose manifest carries
 * `"musepi": { "rename": { "package": "<new-agent-pkg>", "natives": "<new-natives-pkg>" }, "dist": "binary" }`.
 * Updaters that understand `rename` follow the pointer and resolve the
 * release from the renamed package instead ({@link getLatestRelease});
 * older deployed updaters ignore it and take the `dist: "binary"` escape
 * hatch, replacing the install with the GitHub release binary rather than
 * installing the stub via bun/npm.
 *
 * The renamed package's own manifest MUST declare `"dist": "npm"` (so
 * package-manager installs stay package-managed across a major bump) and
 * MUST continue the old version line (a version reset would compare as
 * "already up to date" against the running build).
 */
export function resolveReleaseRename(manifest: unknown): ReleaseRename | undefined {
	if (!isRecord(manifest) || !isRecord(manifest.musepi)) return undefined;
	const rename = manifest.musepi.rename;
	if (!isRecord(rename) || typeof rename.package !== "string" || rename.package.length === 0) return undefined;
	const natives = rename.natives;
	return {
		pkg: rename.package,
		natives: typeof natives === "string" && natives.length > 0 ? natives : undefined,
	};
}

function majorVersion(version: string): number {
	const major = Number.parseInt(version, 10);
	return Number.isNaN(major) ? 0 : major;
}

/**
 * Whether the update must bypass bun/npm and install the release binary.
 *
 \* An explicit `musepi.dist` (legacy: `musepi.dist`) wins in both directions. Without one, a release with
 * a higher major than the running build is assumed not npm-installable: the
 * runtime may have changed out from under the package layout, and the pinned
 * `@musepi/pi-natives*` companions ({@link buildBunInstallArgs}) may not
 * exist at that version, which would strand bun/npm-managed installs behind a
 * hard install failure. Homebrew and mise installs are unaffected — both
 * already pull GitHub release binaries.
 */
export function shouldForceBinaryUpdate(
	release: { version: string; dist?: ReleaseDist },
	currentVersion: string = VERSION,
): boolean {
	if (release.dist !== undefined) return release.dist === "binary";
	return majorVersion(release.version) > majorVersion(currentVersion);
}

/**
 * Select and validate the binary asset from GitHub release metadata.
 */
export function resolveReleaseBinaryAsset(
	release: unknown,
	expectedTag: string,
	binaryName: string,
): ReleaseBinaryAsset {
	if (!isRecord(release)) {
		throw new Error("Invalid GitHub release metadata");
	}
	if (release.tag_name !== expectedTag) {
		throw new Error(`GitHub release tag mismatch: expected ${expectedTag}`);
	}
	if (release.draft !== false || release.prerelease !== false) {
		throw new Error(`GitHub release ${expectedTag} is not a published stable release`);
	}
	if (!Array.isArray(release.assets)) {
		throw new Error(`GitHub release ${expectedTag} has no asset list`);
	}

	const matches = release.assets.filter(asset => isRecord(asset) && asset.name === binaryName);
	if (matches.length !== 1) {
		throw new Error(`GitHub release ${expectedTag} has ${matches.length} assets named ${binaryName}`);
	}

	const asset = matches[0];
	if (!isRecord(asset) || asset.state !== "uploaded") {
		throw new Error(`GitHub release asset ${binaryName} is not fully uploaded`);
	}
	if (typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
		throw new Error(`GitHub release asset ${binaryName} has an invalid size`);
	}
	if (typeof asset.digest !== "string") {
		throw new Error(`GitHub release asset ${binaryName} has no digest`);
	}
	const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest)?.[1];
	if (!digest) {
		throw new Error(`GitHub release asset ${binaryName} has an unsupported digest`);
	}

	const expectedUrl = `https://github.com/${REPO}/releases/download/${expectedTag}/${binaryName}`;
	if (asset.browser_download_url !== expectedUrl) {
		throw new Error(`GitHub release asset ${binaryName} has an unexpected download URL`);
	}

	return {
		url: expectedUrl,
		size: asset.size,
		digest: `sha256:${digest.toLowerCase()}`,
	};
}

async function getReleaseBinaryAsset(
	expectedVersion: string,
	binaryName: string,
	fetchImpl: Fetch = fetch,
	githubToken: string | undefined = $env.GITHUB_TOKEN || $env.GH_TOKEN,
): Promise<ReleaseBinaryAsset> {
	const tag = `v${expectedVersion}`;
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

	let response: Response;
	try {
		response = await fetchImpl(`${GITHUB_API}/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, {
			headers,
			signal: withTimeoutSignal(RELEASE_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out fetching GitHub release metadata after 30s", { cause: err });
		}
		throw err;
	}
	if ((response.status === 403 && !githubToken) || response.status === 429) {
		throw new Error(
			"GitHub API rate limit exceeded while fetching release metadata; retry later or set GITHUB_TOKEN or GH_TOKEN",
		);
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub release metadata: ${response.statusText}`);
	}

	return resolveReleaseBinaryAsset(await response.json(), tag, binaryName);
}

export interface VerifiedBinaryDownloadOptions {
	url: string;
	targetPath: string;
	expectedSize: number;
	expectedDigest: string;
	fetchImpl?: Fetch;
}

/**
 * Download a binary and verify its GitHub-reported size and SHA-256 digest.
 */
export async function downloadVerifiedBinary(options: VerifiedBinaryDownloadOptions): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	await unlinkIfExists(options.targetPath);

	let response: Response;
	try {
		response = await fetchImpl(options.url, {
			redirect: "follow",
			signal: withTimeoutSignal(BINARY_DOWNLOAD_TIMEOUT_MS),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		throw err;
	}
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}

	const hash = createHash("sha256");
	let size = 0;
	const verifier = new Transform({
		transform(chunk, _encoding, callback) {
			size += chunk.byteLength;
			if (size > options.expectedSize) {
				callback(
					new Error(
						`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received at least ${size}`,
					),
				);
				return;
			}
			hash.update(chunk);
			callback(null, chunk);
		},
	});

	try {
		await pipeline(response.body, verifier, fs.createWriteStream(options.targetPath, { mode: 0o600 }));
		const digest = `sha256:${hash.digest("hex")}`;
		if (size !== options.expectedSize) {
			throw new Error(`Downloaded binary size mismatch: expected ${options.expectedSize} bytes, received ${size}`);
		}
		if (digest !== options.expectedDigest) {
			throw new Error(`Downloaded binary digest mismatch: expected ${options.expectedDigest}, received ${digest}`);
		}
		await fs.promises.chmod(options.targetPath, 0o755);
	} catch (err) {
		await unlinkIfExists(options.targetPath);
		if (isTimeoutError(err)) {
			throw new Error("Timed out downloading release binary after 15 minutes", { cause: err });
		}
		throw err;
	}
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean; plugins: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
		plugins: args.includes("--plugins") || args.includes("-l"),
	};
}

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getNpmGlobalBinDir(): Promise<string | undefined> {
	if (!$which("npm")) return undefined;
	try {
		const result = await $`npm prefix -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const prefix = result.text().trim();
		if (prefix.length === 0) return undefined;
		return process.platform === "win32" ? prefix : path.join(prefix, "bin");
	} catch {
		return undefined;
	}
}

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	for (const formula of [HOMEBREW_FORMULA, APP_NAME]) {
		try {
			const result = await $`brew --prefix ${formula}`.quiet().nothrow();
			if (result.exitCode !== 0) continue;
			const output = result.text().trim();
			if (output.length > 0) return output;
		} catch {}
	}
	return undefined;
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved musepi path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve both the file and its parent directory: the file catches manager
	// links like Homebrew's `bin/musepi -> Cellar/.../bin/musepi`; the parent fallback
	// still tolerates fresh install paths where the file does not exist yet.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

function isPathInManagerRoot(linkTarget: string, nodeModulesDir: string): boolean {
	if (isPathInDirectoryLexical(linkTarget, nodeModulesDir)) return true;
	// Resolve only the manager root. Resolving the link target itself would
	// follow globally linked packages into their checkout and lose ownership.
	const nodeModulesReal = tryRealpath(path.resolve(nodeModulesDir));
	return nodeModulesReal !== undefined && isPathInDirectoryLexical(linkTarget, nodeModulesReal);
}

function resolveNpmGlobalNodeModulesDir(globalBinDir: string | undefined): string | undefined {
	if (!globalBinDir) return undefined;
	if (process.platform === "win32") return path.join(globalBinDir, "node_modules");
	return path.join(path.dirname(globalBinDir), "lib", "node_modules");
}

function isManagerOwnedBinEntry(linkTarget: string | undefined, nodeModulesDir: string | undefined): boolean {
	// Non-symlink launchers and unreadable links retain the existing bin-dir
	// classification. A readable link must point through the manager's exact
	// global node_modules tree.
	return linkTarget === undefined || (nodeModulesDir !== undefined && isPathInManagerRoot(linkTarget, nodeModulesDir));
}

type UpdateMethod = "brew" | "mise" | "nix" | "bun" | "npm" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
	npmBinDir?: string;
	/** Bun's configured global package directory, independent of its bin directory. */
	bunGlobalDir?: string;
	/**
	 * Whether the resolved musepi path is a plain file (the standalone binary)
	 * rather than a package-manager symlink. Stops a binary install from being
	 * misrouted to npm/bun when the global bin dir overlaps the installer's
	 * target directory.
	 */
	musepiIsRegularFile?: boolean;
	/**
	 * Absolute path named by the bin entry's first symlink hop. This deliberately
	 * preserves a global package symlink instead of resolving into its checkout.
	 */
	musepiLinkTarget?: string;
}

type UpdateTarget =
	| { method: "brew" }
	| { method: "mise" }
	| { method: "nix" }
	| { method: "bun"; path?: string }
	| { method: "npm"; path?: string }
	| { method: "binary"; path: string; replacesSymlink: boolean };

function resolveUpdateMethod(
	musepiPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const {
		bunGlobalDir,
		homebrewPrefix,
		miseBinDirs = [],
		miseDataDir,
		npmBinDir,
		musepiIsRegularFile = false,
		musepiLinkTarget,
	} = options;
	const launcherExtension = path.extname(musepiPath).toLowerCase();
	const isWindowsScriptLauncher =
		launcherExtension === ".cmd" || launcherExtension === ".ps1" || launcherExtension === ".bat";
	if (isPathInDirectory(musepiPath, NIX_STORE_DIR)) return "nix";
	if (homebrewPrefix && isPathInDirectory(musepiPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(musepiPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(musepiPath, path.join(miseDataDir, "shims"))) return "mise";
	// A plain executable file in a package-manager bin dir is the standalone
	// binary the installer placed there, not an npm/bun-managed install (those
	// symlink into node_modules on POSIX). When the global bin dir overlaps the
	// installer's default (~/.local/bin), classifying by directory alone routes
	// a binary install through npm/bun, whose reinstall then collides with the
	// existing file (npm EEXIST). Fall through to binary replacement instead.
	// Windows is excluded: there package managers write regular-file shims
	// (bun's .exe launcher, npm's .cmd/.ps1), so a regular file is NOT evidence
	// of a standalone install and the override would hijack managed installs.
	const isStandaloneRegularFile = musepiIsRegularFile && process.platform !== "win32";
	const bunNodeModulesDir = resolveBunGlobalNodeModulesDirFromLocations({
		globalDir: bunGlobalDir,
		globalBinDir: bunBinDir,
	});
	if (
		bunBinDir &&
		isPathInDirectory(musepiPath, bunBinDir) &&
		!isStandaloneRegularFile &&
		isManagerOwnedBinEntry(musepiLinkTarget, bunNodeModulesDir)
	) {
		return "bun";
	}
	const npmNodeModulesDir = resolveNpmGlobalNodeModulesDir(npmBinDir);
	if (
		npmBinDir &&
		isPathInDirectory(musepiPath, npmBinDir) &&
		!isStandaloneRegularFile &&
		isManagerOwnedBinEntry(musepiLinkTarget, npmNodeModulesDir)
	) {
		return "npm";
	}
	if (isWindowsScriptLauncher) return "npm";
	return "binary";
}

export function resolveUpdateMethodForTest(
	musepiPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(musepiPath, bunBinDir, options);
}

/** Resolve an update target from the concrete PATH entry selected by the shell. */
export function resolveUpdateTargetFromPath(
	musepiPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions & { allowPackageManagers: boolean },
): UpdateTarget {
	let musepiIsRegularFile = false;
	let musepiIsSymlink = false;
	let musepiLinkTarget: string | undefined;
	let musepiRealpath: string | undefined;
	try {
		const stat = fs.lstatSync(musepiPath);
		musepiIsRegularFile = stat.isFile() && !stat.isSymbolicLink();
		musepiIsSymlink = stat.isSymbolicLink();
		if (musepiIsSymlink) {
			const rawTarget = fs.readlinkSync(musepiPath);
			const linkDir = path.dirname(musepiPath);
			musepiLinkTarget = path.resolve(tryRealpath(linkDir) ?? linkDir, rawTarget);
			musepiRealpath = tryRealpath(musepiPath);
		}
	} catch {}

	const method = resolveUpdateMethod(musepiPath, bunBinDir, {
		...options,
		musepiIsRegularFile,
		musepiLinkTarget,
	});
	if (method === "binary") {
		// A package-manager-enabled update follows a foreign alias to replace
		// its standalone binary. Binary-only releases intentionally replace the
		// selected manager launcher in place.
		const binaryPath = options.allowPackageManagers && musepiIsSymlink ? (musepiRealpath ?? musepiPath) : musepiPath;
		return { method, path: binaryPath, replacesSymlink: musepiIsSymlink && binaryPath === musepiPath };
	}
	if (method === "bun" || method === "npm") return { method, path: musepiPath };
	return { method };
}
/**
 * Resolve how the running install should be updated.
 *
 * `allowPackageManagers: false` skips the `bun pm bin -g` / `npm prefix -g`
 * probes entirely — used for binary-only releases, where routing through a
 * package manager is never valid and the probes would be wasted subprocesses.
 * Homebrew/mise detection always runs: both managers install GitHub release
 * binaries and stay valid regardless of how the release is distributed.
 */
async function resolveUpdateTarget(options: { allowPackageManagers: boolean }): Promise<UpdateTarget> {
	const bunBinDir = options.allowPackageManagers ? await getBunGlobalBinDir() : undefined;
	const npmBinDir = options.allowPackageManagers ? await getNpmGlobalBinDir() : undefined;
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const musepiPath = resolveOmpPath();

	if (musepiPath) {
		return resolveUpdateTargetFromPath(musepiPath, bunBinDir, {
			allowPackageManagers: options.allowPackageManagers,
			bunGlobalDir: options.allowPackageManagers ? process.env.BUN_INSTALL_GLOBAL_DIR : undefined,
			homebrewPrefix,
			miseBinDirs,
			miseDataDir,
			npmBinDir,
		});
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/** Bound on `musepi.rename` hops so a broken pointer chain cannot loop forever. */
const MAX_RENAME_HOPS = 3;

async function fetchLatestManifest(
	pkg: string,
	timeoutMs: number,
): Promise<{ version: string; manifest: Record<string, unknown> }> {
	let response: Response;
	try {
		response = await fetch(`${NPM_REGISTRY}${pkg}/latest`, {
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching release info for ${pkg} after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		throw err;
	}
	if (!response.ok) {
		const error = new Error(`Failed to fetch release info for ${pkg}: ${response.statusText}`);
		(error as Error & { status?: number }).status = response.status;
		throw error;
	}

	const data: unknown = await response.json();
	if (!isRecord(data) || typeof data.version !== "string") {
		throw new Error(`Malformed npm registry response for ${pkg}: missing version`);
	}
	return { version: data.version, manifest: data };
}

/**
 * Get the latest release info from the npm registry, following `musepi.rename`
 * pointers ({@link resolveReleaseRename}) when the package has moved to a new
 * npm name. Version, dist, and install names all come from the final manifest
 * in the chain. Uses npm instead of GitHub API to avoid unauthenticated rate
 * limiting.
 *
 * MusePi never publishes `@musepi/pi-coding-agent` to the registry — the
 * distribution channel is the GitHub release binary. When the registry
 * answers 404 (package absent), fall back to the GitHub release feed
 * ({@link getLatestReleaseFromGitHub}), which routes the update through the
 * standalone-binary replacement path.
 */
export async function getLatestRelease(options: { timeoutMs?: number } = {}): Promise<ReleaseInfo> {
	const timeoutMs = options.timeoutMs ?? RELEASE_METADATA_TIMEOUT_MS;
	try {
		return await getLatestNpmRelease(timeoutMs);
	} catch (err) {
		if (err instanceof Error && (err as Error & { status?: number }).status === 404) {
			return getLatestReleaseFromGitHub(timeoutMs);
		}
		throw err;
	}
}

async function getLatestNpmRelease(timeoutMs: number): Promise<ReleaseInfo> {
	const packages: ReleasePackages = { ...CURRENT_PACKAGES };
	const visited = new Set([packages.pkg]);
	let latest = await fetchLatestManifest(packages.pkg, timeoutMs);
	for (let hop = 0; hop < MAX_RENAME_HOPS; hop++) {
		const rename = resolveReleaseRename(latest.manifest);
		if (!rename || visited.has(rename.pkg)) break;
		visited.add(rename.pkg);
		packages.pkg = rename.pkg;
		if (rename.natives) packages.natives = rename.natives;
		latest = await fetchLatestManifest(packages.pkg, timeoutMs);
	}

	return {
		tag: `v${latest.version}`,
		version: latest.version,
		dist: resolveReleaseDist(latest.manifest),
		packages,
	};
}

/**
 * Resolve the latest release from the GitHub releases feed. Used when the npm
 * registry 404s (MusePi's package is not published there); the release
 * carries `dist: "binary"` so {@link shouldForceBinaryUpdate} routes the
 * update through the standalone-binary replacement path.
 */
async function getLatestReleaseFromGitHub(timeoutMs: number): Promise<ReleaseInfo> {
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const githubToken = $env.GITHUB_TOKEN || $env.GH_TOKEN;
	if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

	let response: Response;
	try {
		response = await fetch(`${GITHUB_API}/repos/${REPO}/releases/latest`, {
			headers,
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching GitHub release info after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		throw err;
	}
	if ((response.status === 403 && !githubToken) || response.status === 429) {
		throw new Error(
			"GitHub API rate limit exceeded while fetching release metadata; retry later or set GITHUB_TOKEN or GH_TOKEN",
		);
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch GitHub release info: ${response.statusText}`);
	}

	const data: unknown = await response.json();
	if (!isRecord(data) || typeof data.tag_name !== "string") {
		throw new Error("Malformed GitHub release response: missing tag_name");
	}
	const tag = data.tag_name;
	const version = tag.startsWith("v") ? tag.slice(1) : tag;

	return {
		tag,
		version,
		dist: "binary",
		packages: CURRENT_PACKAGES,
	};
}

interface BunInstallCachePruneResult {
	scannedPackages: number;
	removedEntries: number;
}

interface BunCachePackageGroup {
	actualDirs: Map<string, string[]>;
	markerDir?: string;
	markerEntries: Map<string, string[]>;
}

function stripBunCacheVersionSuffix(name: string): string {
	const metadataIndex = name.indexOf("@@");
	return metadataIndex === -1 ? name : name.slice(0, metadataIndex);
}

async function readdirIfExists(dir: string): Promise<fs.Dirent[]> {
	try {
		return await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

function getBunCacheGroup(groups: Map<string, BunCachePackageGroup>, packageName: string): BunCachePackageGroup {
	let group = groups.get(packageName);
	if (!group) {
		group = { actualDirs: new Map(), markerEntries: new Map() };
		groups.set(packageName, group);
	}
	return group;
}

function addVersionPath(entries: Map<string, string[]>, version: string, entryPath: string): void {
	const paths = entries.get(version);
	if (paths) {
		paths.push(entryPath);
		return;
	}
	entries.set(version, [entryPath]);
}

async function addBunCacheActualDir(
	groups: Map<string, BunCachePackageGroup>,
	dirPath: string,
	packageNames: Set<string> | undefined,
): Promise<void> {
	try {
		const manifest = (await Bun.file(path.join(dirPath, "package.json")).json()) as Partial<
			Record<"name" | "version", unknown>
		>;
		if (typeof manifest.name !== "string" || typeof manifest.version !== "string") return;
		if (packageNames && !packageNames.has(manifest.name)) return;
		const group = getBunCacheGroup(groups, manifest.name);
		addVersionPath(group.actualDirs, manifest.version, dirPath);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}

async function addBunCacheMarkerDir(
	groups: Map<string, BunCachePackageGroup>,
	packageName: string,
	markerDir: string,
	packageNames: Set<string> | undefined,
): Promise<void> {
	if (packageNames && !packageNames.has(packageName)) return;
	const markerEntries = await readdirIfExists(markerDir);
	const group = getBunCacheGroup(groups, packageName);
	group.markerDir = markerDir;
	for (const entry of markerEntries) {
		const cacheVersion = stripBunCacheVersionSuffix(entry.name);
		addVersionPath(group.markerEntries, cacheVersion, path.join(markerDir, entry.name));
	}
}

async function collectBunCacheGroups(
	cacheDir: string,
	packageNames: Set<string> | undefined,
): Promise<Map<string, BunCachePackageGroup>> {
	const groups = new Map<string, BunCachePackageGroup>();
	for (const entry of await readdirIfExists(cacheDir)) {
		if (!entry.isDirectory()) continue;
		const entryPath = path.join(cacheDir, entry.name);
		if (entry.name.startsWith("@")) {
			for (const scopedEntry of await readdirIfExists(entryPath)) {
				if (!scopedEntry.isDirectory()) continue;
				const scopedEntryPath = path.join(entryPath, scopedEntry.name);
				const versionSeparator = scopedEntry.name.lastIndexOf("@");
				if (versionSeparator === -1) {
					await addBunCacheMarkerDir(groups, `${entry.name}/${scopedEntry.name}`, scopedEntryPath, packageNames);
				} else {
					await addBunCacheActualDir(groups, scopedEntryPath, packageNames);
				}
			}
			continue;
		}
		const versionSeparator = entry.name.lastIndexOf("@");
		if (versionSeparator === -1) {
			await addBunCacheMarkerDir(groups, entry.name, entryPath, packageNames);
		} else {
			await addBunCacheActualDir(groups, entryPath, packageNames);
		}
	}
	return groups;
}

async function removeCacheEntries(paths: string[]): Promise<number> {
	for (const entryPath of paths) {
		await fs.promises.rm(entryPath, { recursive: true, force: true });
	}
	return paths.length;
}

/**
 * Prune Bun's package cache so each package keeps only its newest cached version.
 *
 * Bun stores package cache entries as both a package marker directory
 * (`react/19.2.6@@@1`) and a materialized package directory
 * (`react@19.2.6@@@1`). Global `musepi` updates can leave one full copy per
 * release. The marker and materialized entries are removed together so the
 * cache stays internally consistent.
 */
export async function pruneBunInstallCache(
	cacheDir: string,
	packageNames?: Set<string>,
): Promise<BunInstallCachePruneResult> {
	const groups = await collectBunCacheGroups(cacheDir, packageNames);
	let scannedPackages = 0;
	let removedEntries = 0;
	for (const group of groups.values()) {
		if (group.actualDirs.size === 0) continue;
		scannedPackages++;
		let latestVersion: string | undefined;
		for (const version of group.actualDirs.keys()) {
			if (!latestVersion || compareVersions(version, latestVersion) > 0) latestVersion = version;
		}
		if (!latestVersion) continue;
		for (const [version, paths] of group.actualDirs) {
			if (version !== latestVersion) removedEntries += await removeCacheEntries(paths);
		}
		for (const [version, paths] of group.markerEntries) {
			if (version !== latestVersion) removedEntries += await removeCacheEntries(paths);
		}
	}
	return { scannedPackages, removedEntries };
}

async function resolveBunInstallCacheDir(): Promise<string | undefined> {
	try {
		const result = await $`bun pm cache`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

interface BunGlobalInstallLocations {
	globalDir?: string;
	globalBinDir?: string;
	cacheDir?: string;
}

/** Resolve Bun's global node_modules root from explicit, default, or cache locations. */
export function resolveBunGlobalNodeModulesDirFromLocations({
	globalDir,
	globalBinDir,
	cacheDir,
}: BunGlobalInstallLocations): string | undefined {
	if (globalDir && globalDir.length > 0) return path.join(globalDir, "node_modules");
	if (globalBinDir && globalBinDir.length > 0) {
		return path.join(path.dirname(globalBinDir), "install", "global", "node_modules");
	}
	if (cacheDir && cacheDir.length > 0) {
		return path.join(path.dirname(cacheDir), "global", "node_modules");
	}
	return undefined;
}

async function resolveBunGlobalNodeModulesDir(cacheDir: string): Promise<string | undefined> {
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		const globalBinDir = result.exitCode === 0 ? result.text().trim() : undefined;
		return resolveBunGlobalNodeModulesDirFromLocations({
			globalDir: process.env.BUN_INSTALL_GLOBAL_DIR,
			globalBinDir,
			cacheDir,
		});
	} catch {
		return resolveBunGlobalNodeModulesDirFromLocations({
			globalDir: process.env.BUN_INSTALL_GLOBAL_DIR,
			cacheDir,
		});
	}
}

async function collectInstalledPackageNames(nodeModulesDir: string): Promise<Set<string>> {
	const packageNames = new Set<string>();
	for (const entry of await readdirIfExists(nodeModulesDir)) {
		if (!entry.isDirectory() || entry.name === ".bin") continue;
		if (entry.name.startsWith("@")) {
			for (const scopedEntry of await readdirIfExists(path.join(nodeModulesDir, entry.name))) {
				if (scopedEntry.isDirectory()) packageNames.add(`${entry.name}/${scopedEntry.name}`);
			}
			continue;
		}
		packageNames.add(entry.name);
	}
	return packageNames;
}

async function pruneBunCacheAfterGlobalInstall(): Promise<BunInstallCachePruneResult | undefined> {
	const cacheDir = await resolveBunInstallCacheDir();
	if (!cacheDir) return undefined;
	const globalNodeModulesDir = await resolveBunGlobalNodeModulesDir(cacheDir);
	const packageNames = globalNodeModulesDir
		? await collectInstalledPackageNames(globalNodeModulesDir)
		: new Set<string>();
	if (packageNames.size === 0 && !path.basename(cacheDir).toLowerCase().includes("musepi")) return undefined;
	return await pruneBunInstallCache(cacheDir, packageNames.size === 0 ? undefined : packageNames);
}

/**
 * Detect a musl-libc Linux host (Alpine, Void-musl) so self-update replaces a
 * musl binary with the musl release asset instead of the glibc build, which
 * would fail to start on the next run. The loader file alone is not sufficient:
 * glibc hosts may have musl installed for cross-compilation.
 */
interface MuslDetectionOptions {
	platform?: NodeJS.Platform;
	alpineRelease?: boolean;
	lddOutput?: string;
}

function detectLddOutput(): string | undefined {
	try {
		const result = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" });
		return `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`;
	} catch {
		return undefined;
	}
}

function isMuslLinux(options: MuslDetectionOptions = {}): boolean {
	if ((options.platform ?? process.platform) !== "linux") return false;
	if (options.alpineRelease ?? fs.existsSync("/etc/alpine-release")) return true;
	return /\bmusl\b/i.test(options.lddOutput ?? detectLddOutput() ?? "");
}

/** Test seam for libc detection. */
export function isMuslLinuxForTest(options: Required<MuslDetectionOptions>): boolean {
	return isMuslLinux(options);
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = isMuslLinux() ? "linux-musl" : "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Resolve the path that `musepi` maps to in the user's PATH.
 */
function resolveOmpPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run a specific binary and check if it reports the expected version.
 */
async function verifyBinaryAtPath(binaryPath: string, expectedVersion: string): Promise<InstalledVersionVerification> {
	try {
		const result = await $`${binaryPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: binaryPath };
		const output = result.text().trim();
		// Output format: "musepi/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: binaryPath };
	} catch {
		return { ok: false, path: binaryPath };
	}
}

/**
 * Run the PATH-resolved musepi binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const musepiPath = resolveOmpPath();
	if (!musepiPath) return { ok: false };
	return await verifyBinaryAtPath(musepiPath, expectedVersion);
}

function printVerifiedVersion(expectedVersion: string): void {
	console.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * Print post-update verification result.
 */
async function printVerification(expectedVersion: string): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion);
	if (result.ok) {
		printVerifiedVersion(expectedVersion);
		return;
	}
	console.log(chalk.yellow(`\nWarning: ${formatVerificationFailure(result, expectedVersion)}`));
	console.log(
		chalk.yellow(
			`You may need to reinstall: curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh`,
		),
	);
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Remove a backup binary without letting the removal abort a completed update.
 *
 * On Windows the executable that was just moved aside is still mapped as the
 * running process image, so unlinking it fails with EPERM/EACCES until this
 * process exits (issue #845). The replacement and verification already
 * succeeded by the time we get here, so every error is swallowed; the leftover
 * is reclaimed by {@link sweepStaleUpdateArtifacts} on the next update once it
 * is no longer in use. Returns whether the file is gone.
 */
async function removeBackupBestEffort(filePath: string): Promise<boolean> {
	try {
		await fs.promises.unlink(filePath);
		return true;
	} catch (err) {
		return isEnoent(err);
	}
}

/**
 * Best-effort removal of binary-update leftovers from earlier runs.
 *
 * Each self-update writes to `<binary>.<timestamp>.<pid>.new` and moves the
 * previous executable to `<binary>.<timestamp>.<pid>.bak` before swapping the
 * new one in. On Windows a backup cannot be deleted while the updating process
 * is alive (it is the running process image), so it is left for a later run to
 * reclaim once its owning process has exited. A `.new` temp file only survives
 * a hard kill mid-download; it is reaped once older than the download window,
 * which a live download cannot exceed without timing out and cleaning up after
 * itself — so a concurrent run's in-progress temp is never deleted. Legacy
 * fixed `<binary>.bak` / `<binary>.new` names (from before suffixes were made
 * unique) are matched too, so users upgrading from a buggy release get the
 * orphaned files cleaned up.
 */
export async function sweepStaleUpdateArtifacts(targetPath: string): Promise<void> {
	const dir = path.dirname(targetPath);
	const base = path.basename(targetPath);
	let entries: string[];
	try {
		entries = await fs.promises.readdir(dir);
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		if (!entry.startsWith(`${base}.`)) continue;
		const suffix = entry.endsWith(".bak") ? ".bak" : entry.endsWith(".new") ? ".new" : undefined;
		if (!suffix) continue;
		// Legacy "<base><suffix>" → empty middle; new "<base>.<timestamp>.<pid><suffix>"
		// → dot-separated numeric run. Anything else is an unrelated file.
		const middle = entry.slice(base.length + 1, entry.length - suffix.length);
		if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
		const full = path.join(dir, entry);
		if (suffix === ".new") {
			// A temp file may belong to a concurrent update still downloading, so
			// only reap ones older than the download window.
			let mtimeMs: number;
			try {
				mtimeMs = (await fs.promises.stat(full)).mtimeMs;
			} catch {
				continue;
			}
			if (now - mtimeMs < BINARY_DOWNLOAD_TIMEOUT_MS) continue;
		}
		await removeBackupBestEffort(full);
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		// `backupPath` is unique per attempt (see updateViaBinaryAt), so this rename
		// never has to overwrite — or unlink — a possibly-locked leftover from an
		// earlier run. Renaming the running executable itself is permitted on
		// Windows; only deleting its still-mapped image is not.
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		// Swap done and verified. On Windows the backup is still the running
		// process image and cannot be unlinked until this process exits, so a
		// failure here must NOT fail an otherwise-successful update.
		await removeBackupBestEffort(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

function buildVersionedPackageInstallArgs(
	expectedVersion: string,
	nativeTag: string,
	packages: ReleasePackages,
): string[] {
	const args = [`${packages.pkg}@${expectedVersion}`, `${packages.natives}@${expectedVersion}`];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${packages.natives}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

/**
 * Build the bun argv used to globally install a specific musepi version.
 *
 * The version is selected by hitting {@link NPM_REGISTRY} directly in
 * {@link getLatestRelease}, so the install MUST observe the same catalog:
 *
 * - `--registry=${NPM_REGISTRY}` pins the install to the official registry
 *   regardless of the user's bunfig/`.npmrc`. A mirror (corporate proxy,
 *   Taobao, …) that hasn't yet replicated the release would otherwise reject
 *   a version the upstream registry already advertises.
 * - `--no-cache` tells bun to ignore its on-disk manifest snapshot so it
 *   re-fetches metadata from that registry on every invocation.
 *
 * Together these two flags make `musepi update` produce exactly the registry
 * lookup the version check just performed. See #1686.
 *
 * Also pins {@link NATIVES_PACKAGE} and the platform-specific
 * `@musepi/pi-natives-<tag>` leaf to `expectedVersion`. `bun install -g`
 * does not reliably refresh transitive `optionalDependencies` when the
 * top-level package is the only one bumped, so the native addon and its
 * version sentinel can drift out of sync with the freshly installed
 * `@musepi/pi-coding-agent` and the loader aborts at
 * `validateLoadedBindings` on the next launch
 * (`The .node file on disk is from a different release than this loader`).
 * Listing the natives explicitly forces bun to replace them in lock-step.
 * The leaf is added only on tags the release pipeline actually publishes
 * ({@link SUPPORTED_NATIVE_TAGS}) so unsupported platforms still fail with
 * the original "no matching version" message instead of `EBADPLATFORM`.
 * See #1824.
 */
export function buildBunInstallArgs(
	expectedVersion: string,
	nativeTag: string = currentNativeTag(),
	packages: ReleasePackages = CURRENT_PACKAGES,
): string[] {
	return [
		"install",
		"-g",
		"--no-cache",
		`--registry=${NPM_REGISTRY}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag, packages),
	];
}

/**
 * Build the npm argv used to update npm-managed global installs.
 *
 * `force` is set only for rename migrations: npm refuses to write the `musepi`
 * bin while the old package still owns it (`EEXIST`), and the migration
 * installs the new package BEFORE removing the old one so a failed install
 * never leaves the user without a working `musepi`.
 */
export function buildNpmInstallArgs(
	expectedVersion: string,
	nativeTag: string = currentNativeTag(),
	packages: ReleasePackages = CURRENT_PACKAGES,
	flags: { force?: boolean } = {},
): string[] {
	return [
		"install",
		"-g",
		...(flags.force ? ["--force"] : []),
		`--registry=${NPM_REGISTRY}`,
		...buildVersionedPackageInstallArgs(expectedVersion, nativeTag, packages),
	];
}

export function buildHomebrewUpdateArgs(force: boolean): string[] {
	return [force ? "reinstall" : "upgrade", HOMEBREW_FORMULA];
}

export function buildMiseUpgradeArgs(): string[] {
	return ["upgrade", MISE_TOOL, "--bump"];
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

/**
 * Old-name globals a rename migration removes after the new install exists:
 * the set difference between the old install's top-level globals
 * ({@link buildVersionedPackageInstallArgs} installs the agent, natives core,
 * and platform leaf explicitly) and the resolved install's. An agent-only
 * rename keeps the natives names, and removing them would strip the addon
 * the new install just pinned.
 */
export function buildRenameCleanupPackages(
	packages: ReleasePackages,
	nativeTag: string = currentNativeTag(),
): string[] {
	const old = [PACKAGE, NATIVES_PACKAGE];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		old.push(`${NATIVES_PACKAGE}-${nativeTag}`);
	}
	const newLeaf = `${packages.natives}-${nativeTag}`;
	return old.filter(name => name !== packages.pkg && name !== packages.natives && name !== newLeaf);
}

/** Injectable shell steps for {@link migrateRenamedInstall}; commands return process exit codes. */
export interface RenameMigrationSteps {
	/** Globally install the new package names. MUST be idempotent: re-running re-links the `musepi` bin. */
	install(): Promise<number>;
	/** Remove the old-name globals. */
	removeOld(): Promise<number>;
	/** Check the PATH-resolved `musepi` against the expected version. */
	verify(): Promise<InstalledVersionVerification>;
}

/** Production {@link RenameMigrationSteps}: bun/npm global installs plus PATH verification. */
function packageManagerMigrationSteps(manager: "bun" | "npm", release: ReleaseInfo): RenameMigrationSteps {
	const nativeTag = currentNativeTag();
	return {
		async install() {
			if (manager === "bun") {
				const args = buildBunInstallArgs(release.version, nativeTag, release.packages);
				return (await $`bun ${args}`.nothrow()).exitCode;
			}
			const args = buildNpmInstallArgs(release.version, nativeTag, release.packages, { force: true });
			return (await $`npm ${args}`.nothrow()).exitCode;
		},
		async removeOld() {
			// One invocation per package: a single batched remove fails wholesale
			// when any name is absent (e.g. the platform leaf on an old install),
			// which would skip the agent package that actually owns the bin.
			let agentExit = 0;
			for (const pkg of buildRenameCleanupPackages(release.packages, nativeTag)) {
				const result =
					manager === "bun"
						? await $`bun remove -g ${pkg}`.quiet().nothrow()
						: await $`npm uninstall -g ${pkg}`.quiet().nothrow();
				if (pkg === PACKAGE) agentExit = result.exitCode;
			}
			return agentExit;
		},
		verify: () => verifyInstalledVersion(release.version),
	};
}

/**
 * Migrate a package-manager install across an `musepi.rename` hop without a
 * window where no working `musepi` exists:
 *
 * 1. Install the new package FIRST. Nothing has been removed yet, so a
 *    failure here leaves the old install fully functional.
 * 2. Remove the old-name globals. Failure is non-fatal: a stale package
 *    wastes disk, but the bin already points at the new install.
 * 3. Verify the PATH-resolved `musepi`. If the removal deleted the shared bin
 *    link (manager-dependent), re-run the idempotent install to restore it
 *    and verify again; only a repeated failure aborts, with a recovery hint.
 */
export async function migrateRenamedInstall(release: ReleaseInfo, steps: RenameMigrationSteps): Promise<void> {
	console.log(chalk.dim(`npm package renamed to ${release.packages.pkg}; migrating this install.`));
	const installExit = await steps.install();
	if (installExit !== 0) {
		throw new Error(
			`install of ${release.packages.pkg} failed with exit code ${installExit}; the existing install was left untouched`,
		);
	}

	const removeExit = await steps.removeOld();
	if (removeExit !== 0) {
		console.log(chalk.yellow(`Warning: could not remove the old ${PACKAGE} package; remove it manually later.`));
	}

	let verification = await steps.verify();
	if (!verification.ok) {
		// Removing the old package may have taken the shared bin link with it;
		// reinstalling the new package restores the link.
		if ((await steps.install()) === 0) {
			verification = await steps.verify();
		}
	}
	if (!verification.ok) {
		throw new Error(
			`${formatVerificationFailure(verification, release.version)}; reinstall with: curl -fsSL https://raw.githubusercontent.com/MuseLinn/MusePi/main/scripts/install.sh | sh`,
		);
	}
	printVerifiedVersion(release.version);
}

/**
 * Update via package manager.
 */
async function updateViaBun(release: ReleaseInfo): Promise<void> {
	console.log(chalk.dim("Updating via bun..."));
	if (release.packages.pkg !== PACKAGE) {
		await migrateRenamedInstall(release, packageManagerMigrationSteps("bun", release));
	} else {
		const args = buildBunInstallArgs(release.version, currentNativeTag(), release.packages);
		const result = await $`bun ${args}`.nothrow();
		if (result.exitCode !== 0) {
			throw new Error(`bun install failed with exit code ${result.exitCode}`);
		}
		await printVerification(release.version);
	}
	try {
		const pruneResult = await pruneBunCacheAfterGlobalInstall();
		if (pruneResult && pruneResult.removedEntries > 0) {
			console.log(chalk.dim(`Pruned ${pruneResult.removedEntries} stale Bun cache entries`));
		}
	} catch (err) {
		console.log(chalk.yellow(`Warning: could not prune stale Bun cache entries: ${err}`));
	}
}

async function updateViaNpm(release: ReleaseInfo): Promise<void> {
	console.log(chalk.dim("Updating via npm..."));
	if (release.packages.pkg !== PACKAGE) {
		await migrateRenamedInstall(release, packageManagerMigrationSteps("npm", release));
		return;
	}
	const args = buildNpmInstallArgs(release.version, currentNativeTag(), release.packages);
	const result = await $`npm ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`npm install failed with exit code ${result.exitCode}`);
	}

	await printVerification(release.version);
}

async function updateViaHomebrew(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating Homebrew formulae..."));
	const update = await $`brew update`.nothrow();
	if (update.exitCode !== 0) {
		throw new Error(`brew update failed with exit code ${update.exitCode}`);
	}

	console.log(chalk.dim("Updating via Homebrew..."));
	const args = buildHomebrewUpdateArgs(force);
	const result = await $`brew ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`brew ${args[0]} failed with exit code ${result.exitCode}`);
	}

	await printVerification(expectedVersion);
}

async function updateViaMise(expectedVersion: string, force: boolean): Promise<void> {
	console.log(chalk.dim("Updating via mise..."));
	const args = buildMiseUpgradeArgs();
	const result = await $`mise ${args}`.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`mise upgrade failed with exit code ${result.exitCode}`);
	}

	if (force) {
		const forceArgs = buildMiseForceInstallArgs(expectedVersion);
		const forceResult = await $`mise ${forceArgs}`.nothrow();
		if (forceResult.exitCode !== 0) {
			throw new Error(`mise install --force failed with exit code ${forceResult.exitCode}`);
		}
	}

	await printVerification(expectedVersion);
}

// Monotonic within this process so two updates started in the same millisecond
// (same pid, same `Date.now()`) still get distinct temp/backup paths. Kept
// numeric so the artifact sweep's `\d+(\.\d+)*` matcher still reclaims them.
let updateAttemptSeq = 0;

/**
 * Download a release binary to a target path, replacing an existing file.
 */
export async function updateViaBinaryAt(
	targetPath: string,
	expectedVersion: string,
	options: {
		binaryName?: string;
		fetchImpl?: Fetch;
		githubToken?: string;
		verifyInstalledVersion?: typeof verifyInstalledVersion;
	} = {},
): Promise<void> {
	const binaryName = options.binaryName ?? getBinaryName();
	// Unique per attempt so two overlapping `musepi update` runs never share a temp
	// or backup path. A fixed temp name (`<binary>.new`) let the second run's
	// pre-download unlink delete the first run's still-downloading temp file; the
	// first kept writing to its open fd (size + digest still passed), then chmod
	// hit the missing path and the update aborted (issue #8434). The backup needs
	// the same uniqueness: a stale backup from an earlier update may still be
	// locked (the previous process image on Windows), so a fixed name would force
	// the move-aside rename to overwrite it. pid, timestamp, and a process-local
	// counter keep two updates started in the same millisecond from colliding.
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${targetPath}.${attempt}.new`;
	const backupPath = `${targetPath}.${attempt}.bak`;
	const asset = await getReleaseBinaryAsset(expectedVersion, binaryName, options.fetchImpl, options.githubToken);
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await downloadVerifiedBinary({
		url: asset.url,
		targetPath: tempPath,
		expectedSize: asset.size,
		expectedDigest: asset.digest,
		fetchImpl: options.fetchImpl,
	});
	console.log(chalk.dim(`Verified ${asset.digest}`));

	// Serialize the target swap and stale-artifact sweep per target so two
	// overlapping `musepi update` runs never replace the same binary concurrently
	// or reclaim each other's live backup/temp files. The download above writes
	// to a unique temp path and is safe to overlap; only the swap is shared.
	await withFileLock(targetPath, async () => {
		console.log(chalk.dim("Installing update..."));
		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion,
			verifyInstalledVersion: options.verifyInstalledVersion ?? verifyInstalledVersion,
		});
		// Reclaim backups from earlier updates whose owning process has since exited.
		await sweepStaleUpdateArtifacts(targetPath);
	});
	printVerifiedVersion(expectedVersion);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * In-place forwarder bodies, by shim extension, for launchers that cannot be
 * renamed aside during a script-shim takeover; each execs the sibling exe.
 * The exe name follows the launcher's base name (`musepi.cmd` → `musepi.exe`), so
 * the takeover works for both legacy `musepi.*` installs and current
 * `musepi.*` ones. Rewriting matters for the shims that outrank `.exe` at
 * command resolution: PowerShell prefers `.ps1` and Git Bash resolves the
 * extensionless sh shim first, so leaving the old body behind would keep
 * launching the replaced install.
 */
function shimForwarderBody(ext: string, launcherBase: string): string {
	const exe = `${launcherBase}.exe`;
	switch (ext) {
		case "":
			return `#!/bin/sh\nexec "$(dirname "$0")/${exe}" "$@"\n`;
		case ".cmd":
		case ".bat":
			return `@"%~dp0${exe}" %*\r\n`;
		case ".ps1":
			return `& "$PSScriptRoot\\${exe}" @args\nexit $LASTEXITCODE\n`;
		default:
			throw new Error(`No shim forwarder for extension ${ext}`);
	}
}

/**
 * Take over a Windows script-launcher install for a binary-only release.
 *
 * npm-managed Windows installs are launched through script shims
 * (`musepi`/`musepi.cmd`/`musepi.ps1`) that cannot be overwritten with a native
 * executable. The release binary is installed as `musepi.exe` beside them and
 * the shims are then renamed aside: cmd.exe would already prefer `.exe` via
 * PATHEXT, but PowerShell resolves `.ps1` first, so the takeover only sticks
 * once the shims are out of the way. A working launcher exists at every
 * step — the exe lands before any shim moves, a shim that refuses to move
 * (a running `.cmd` can be renamed but may be held open some other way) is
 * rewritten in place as a forwarder to the exe, and a failed version
 * verification moves everything back.
 */
export async function updateViaShimTakeover(
	shimPath: string,
	expectedVersion: string,
	options: {
		binaryName?: string;
		fetchImpl?: Fetch;
		githubToken?: string;
		verifyBinary?: typeof verifyBinaryAtPath;
	} = {},
): Promise<void> {
	const binaryName = options.binaryName ?? getBinaryName();
	const launcherDir = path.dirname(shimPath);
	// Follow the launcher's base name (musepi.cmd → musepi.exe) so the takeover works
	// for both legacy `musepi.*` installs and current `musepi.*` ones: after the
	// shims retire, the old command must still resolve to the new exe.
	const launcherBase = path.basename(shimPath, path.extname(shimPath));
	const exePath = path.join(launcherDir, `${launcherBase}.exe`);
	const attempt = `${Date.now()}.${process.pid}.${updateAttemptSeq++}`;
	const tempPath = `${exePath}.${attempt}.new`;
	const asset = await getReleaseBinaryAsset(expectedVersion, binaryName, options.fetchImpl, options.githubToken);
	console.log(chalk.dim(`Downloading ${binaryName}…`));
	await downloadVerifiedBinary({
		url: asset.url,
		targetPath: tempPath,
		expectedSize: asset.size,
		expectedDigest: asset.digest,
		fetchImpl: options.fetchImpl,
	});
	console.log(chalk.dim(`Verified ${asset.digest}`));
	const forwarded: Array<{ launcher: string; original: string }> = [];
	const stuck: string[] = [];
	// Serialize the launcher swap and artifact sweep so two overlapping updates
	// never retire the same shims or reclaim a live run's backup before its
	// verification can roll it back.
	await withFileLock(exePath, async () => {
		console.log(chalk.dim(`Installing ${launcherBase}.exe beside the script launcher...`));
		await fs.promises.rename(tempPath, exePath);
		// Retire the shims so PATH resolution lands on the new exe. Renamed, not
		// deleted: restorable on verification failure, and Windows permits
		// renaming a batch file that is still executing. A shim that cannot be
		// renamed (held open without delete sharing) is rewritten in place as a
		// forwarder to the exe — write and rename take different Windows locks,
		// so one can succeed where the other fails.
		const backupSuffix = `${attempt}.bak`;
		const retired: Array<{ launcher: string; backup: string }> = [];
		for (const ext of ["", ".cmd", ".ps1", ".bat"]) {
			const launcher = path.join(launcherDir, `${launcherBase}${ext}`);
			const backup = `${launcher}.${backupSuffix}`;
			try {
				await fs.promises.rename(launcher, backup);
				retired.push({ launcher, backup });
			} catch (err) {
				if (isEnoent(err)) continue;
				try {
					const original = await Bun.file(launcher).text();
					await Bun.write(launcher, shimForwarderBody(ext, launcherBase));
					forwarded.push({ launcher, original });
				} catch {
					stuck.push(launcher);
				}
			}
		}

		// Verify the exe by its explicit path: $which cached the shim path when
		// the update target was resolved, and the shim was just renamed away, so
		// a PATH re-resolution here would test a file that no longer exists.
		const verify = options.verifyBinary ?? verifyBinaryAtPath;
		const verification = await verify(exePath, expectedVersion);
		if (!verification.ok) {
			for (const { launcher, backup } of retired) {
				try {
					await fs.promises.rename(backup, launcher);
				} catch {}
			}
			for (const { launcher, original } of forwarded) {
				try {
					await Bun.write(launcher, original);
				} catch {}
			}
			await unlinkIfExists(exePath);
			throw new Error(
				`${formatVerificationFailure(verification, expectedVersion)}; restored previous ${launcherBase} launcher`,
			);
		}
		for (const { backup } of retired) {
			await removeBackupBestEffort(backup);
		}
		// Reclaim exe backups and retired-shim leftovers from earlier attempts.
		for (const ext of [".exe", "", ".cmd", ".ps1", ".bat"]) {
			await sweepStaleUpdateArtifacts(path.join(launcherDir, `${launcherBase}${ext}`));
		}
	});
	for (const { launcher } of forwarded) {
		console.log(chalk.dim(`Converted ${launcher} to a forwarder (it could not be removed).`));
	}
	for (const launcher of stuck) {
		console.log(
			chalk.yellow(
				`Could not retire ${launcher}; shells that prefer it may keep launching the old version until it is deleted manually.`,
			),
		);
	}
	printVerifiedVersion(expectedVersion);
	console.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

/**
 * Platform-appropriate installer one-liner for recovery instructions.
 *
 * Forces the installer's binary mode (`--binary` / `-Binary`): the default
 * mode prefers a bun-based install whenever bun is present, which would send
 * a user recovering from a binary-only release straight back through bun.
 */
function installerHint(): string {
	// npm is the only distribution channel that is guaranteed reachable (the
	// GitHub repository / installer script is the same identity but requires
	// the public repo to be published). The -g reinstall keeps the PATH entry
	// and installs the current musepi bin.
	return process.platform === "win32"
		? "bun install -g @musepi/pi-coding-agent"
		: "bun install -g @musepi/pi-coding-agent";
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	console.log(chalk.dim(`Current version: ${VERSION}`));

	// Check for updates
	let release: ReleaseInfo;
	try {
		release = await getLatestRelease();
	} catch (err) {
		console.error(chalk.red(`Failed to check for updates: ${err}`));
		process.exit(1);
	}

	const comparison = compareVersions(release.version, VERSION);

	if (comparison <= 0 && !opts.force) {
		console.log(chalk.green(`${theme.status.success} Already up to date`));
		return;
	}

	if (comparison > 0) {
		console.log(chalk.cyan(`New version available: ${release.version}`));
	} else {
		console.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}
	if (release.packages.pkg !== PACKAGE) {
		console.log(chalk.cyan(`The npm package moved to ${release.packages.pkg}; updating migrates this install.`));
	}

	if (opts.check) {
		// Just check, don't install
		return;
	}

	// Choose update method based on the prioritized musepi binary in PATH. For
	// binary-only releases the package managers are never consulted: a bun/npm
	// symlink resolves to method "binary" and is replaced in place, keeping the
	// same PATH entry live.
	try {
		const forceBinary = shouldForceBinaryUpdate(release);
		const target = await resolveUpdateTarget({ allowPackageManagers: !forceBinary });
		if (target.method === "nix") {
			console.log(chalk.yellow("This installation is managed by Nix and cannot update itself."));
			console.log(chalk.dim("Update the flake input or profile that provides musepi, then rebuild."));
		} else if (target.method === "brew") {
			await updateViaHomebrew(release.version, opts.force);
		} else if (target.method === "mise") {
			await updateViaMise(release.version, opts.force);
		} else if (target.method === "bun" || target.method === "npm") {
			if (forceBinary) {
				// Reachable in forced mode only through a Windows script
				// launcher resolved from PATH (the bun/npm bin-dir probes are
				// skipped), so the launcher path is always known.
				if (!target.path) throw new Error(`Could not resolve ${APP_NAME} launcher path in PATH`);
				console.log(chalk.dim("This release ships as a standalone binary; replacing the script launcher."));
				await updateViaShimTakeover(target.path, release.version);
				console.log(
					chalk.yellow(
						`This install is no longer managed by ${target.method}. Removing the old global package may delete this launcher; if it does, reinstall with: ${installerHint()}`,
					),
				);
			} else if (target.method === "bun") {
				await updateViaBun(release);
			} else {
				await updateViaNpm(release);
			}
		} else {
			if (forceBinary && target.replacesSymlink) {
				console.log(chalk.dim("Replacing the package-manager launcher with the standalone binary."));
			}
			await updateViaBinaryAt(target.path, release.version);
			if (forceBinary && target.replacesSymlink) {
				console.log(
					chalk.yellow(
						`This install is no longer managed by bun/npm. Removing the old global package may delete this launcher; if it does, reinstall with: ${installerHint()}`,
					),
				);
			}
		}
	} catch (err) {
		console.error(chalk.red(`Update failed: ${err}`));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check     Check for updates without installing
  -f, --force     Force reinstall even if up to date
  -l, --plugins   Update installed plugins

${chalk.bold("Examples:")}
  ${APP_NAME} update              Update to latest version
  ${APP_NAME} update --check      Check if updates are available
  ${APP_NAME} update --force      Force reinstall
  ${APP_NAME} update -l           Update installed plugins
`);
}
