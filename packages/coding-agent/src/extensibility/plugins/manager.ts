import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getPluginsDir,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectDir,
	getProjectPluginOverridesPath,
	isEnoent,
	logger,
} from "@musepi/pi-utils";
import { loadExtensions } from "../extensions/loader";
import { refreshBunGitCache } from "./bun-git-cache";
import { type GitSource, parseGitUrl } from "./git-url";
import { resolvePluginManifestEntries } from "./loader";
import { readPluginBlock } from "./manifest-block";
import { getInstalledPluginsRegistryPath, readInstalledPluginsRegistry } from "./marketplace/registry";
import { parsePluginId } from "./marketplace/types";
import { extractPackageName, parsePluginSpec } from "./parser";
import { normalizePluginRuntimeConfig } from "./runtime-config";
import { installSpecFor, parseInstallSpec } from "./spec-classifier";
import type {
	DoctorCheck,
	DoctorOptions,
	InstalledPlugin,
	InstallOptions,
	InstallOutputChunk,
	PluginManifest,
	PluginRuntimeConfig,
	PluginSettingSchema,
	ProjectPluginOverrides,
} from "./types";
import { InstallAbortedError } from "./types";

// =============================================================================
// Validation
// =============================================================================

/** Valid npm package name pattern (scoped and unscoped, with optional version) */
const VALID_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-z0-9-._^~>=<]+)?$/i;

/** Characters that are never valid in any plugin install spec — git or npm. */
const SHELL_METACHARS = /[;&|`$(){}<>\\\n\r\t]/;

/**
 * Validate package name to prevent command injection. npm specs only — git
 * specs (`github:user/repo`, `https://github.com/...`, ...) MUST go through
 * {@link validateGitSpec} instead because they contain characters npm rejects
 * (`:`, `/`, `#`, `+`, `@` in non-version positions).
 */
function validatePackageName(name: string): void {
	// Remove version specifier for validation
	const baseName = extractPackageName(name);
	if (!VALID_PACKAGE_NAME.test(baseName)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	// Extra safety: no shell metacharacters
	if (/[;&|`$(){}[\]<>\\]/.test(name)) {
		throw new Error(`Invalid characters in package name: ${name}`);
	}
}

/**
 * Validate a git install spec — accepts `:`, `/`, `#`, `+`, `.`, `-`, `_`,
 * `~`, `@` (which would all fail {@link validatePackageName}) but rejects
 * shell metacharacters so the spec stays safe when forwarded to bun install.
 * `Bun.spawn` does not invoke a shell, but defense-in-depth keeps things
 * obvious for future readers.
 */
function validateGitSpec(spec: string): void {
	if (SHELL_METACHARS.test(spec)) {
		throw new Error(`Invalid characters in plugin source: ${spec}`);
	}
}

/**
 * Stream one package-manager run, forwarding its output as it arrives.
 *
 * Exported so a test can stand in for the package manager: the rollback's
 * repair step is defined by which arguments it runs the manager with, and that
 * is only observable from outside the module.
 *
 * Output is forwarded per chunk rather than collected, because a GUI install has
 * to show progress while the run is in flight; a caller that passes no
 * `onOutput` still gets the same run and the same exit status, it just keeps no
 * transcript.
 *
 * An aborted run kills the whole process tree. A package manager that spawned a
 * lifecycle script outlives its own `bun install` process, and leaving that
 * child running would keep writing into `node_modules` after the rollback
 * restored the manifest — the exact corruption the snapshot exists to prevent.
 *
 * @param argv - the command and its arguments; no shell is involved.
 * @param cwd - directory to run in.
 * @param options - output sink and cancellation for this run.
 * @returns the exit code and the tail of each stream, for a failure message.
 */
export async function runPackageManager(
	argv: readonly string[],
	cwd: string,
	options: { onOutput?: (chunk: InstallOutputChunk) => void; signal?: AbortSignal },
): Promise<{ exitCode: number; stdoutTail: string; stderrTail: string }> {
	const proc = Bun.spawn([...argv], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
	});

	// Cap the retained tail. A failing run's diagnostics matter, but an
	// unbounded buffer would let a chatty run grow without limit while the
	// caller keeps every chunk anyway.
	const TAIL_MAX_CHARS = 8_192;
	let stdoutTail = "";
	let stderrTail = "";

	const forward = (text: string, stream: "stdout" | "stderr"): void => {
		if (text === "") return;
		if (stream === "stdout") stdoutTail = (stdoutTail + text).slice(-TAIL_MAX_CHARS);
		else stderrTail = (stderrTail + text).slice(-TAIL_MAX_CHARS);
		options.onOutput?.({ stream, text });
	};

	// Both pipes are drained concurrently with the exit wait. Awaiting the exit
	// before reading either pipe risks a >64 KiB OS-pipe-buffer deadlock once the
	// manager prints enough progress.
	const read = async (stream: "stdout" | "stderr", body: ReadableStream<Uint8Array> | null) => {
		if (body === null) return;
		const decoder = new TextDecoder();
		for await (const chunk of body) forward(decoder.decode(chunk, { stream: true }), stream);
		// A multi-byte character can straddle two chunks; the final decode emits
		// whatever the streaming decode was holding.
		forward(decoder.decode(), stream);
	};

	const stop = () => {
		try {
			proc.kill();
		} catch {
			// The run already exited; nothing to stop.
		}
	};
	options.signal?.addEventListener("abort", stop, { once: true });

	try {
		const [exitCode] = await Promise.all([proc.exited, read("stdout", proc.stdout), read("stderr", proc.stderr)]);
		return { exitCode, stdoutTail, stderrTail };
	} finally {
		options.signal?.removeEventListener("abort", stop);
	}
}

function findGitPackageName(source: GitSource, deps: Record<string, string>): string | undefined {
	for (const [key, value] of Object.entries(deps)) {
		if (typeof value !== "string") {
			continue;
		}
		const installedSource = parseGitUrl(value);
		if (installedSource && installedSource.host === source.host && installedSource.path === source.path) {
			return key;
		}
	}
	return undefined;
}

interface PluginPackageSnapshot {
	readonly actualName: string;
	readonly packagePath: string;
	readonly backupRoot: string;
	readonly backupPath: string;
}

interface RuntimePackageJson {
	name?: unknown;
}
// =============================================================================
// Plugin Manager
// =============================================================================

/** The package-manager seam {@link PluginManager} runs every install through. */
export type PackageManagerRunner = typeof runPackageManager;

export class PluginManager {
	#runtimeConfig: PluginRuntimeConfig | null = null;
	#cwd: string;
	#run: PackageManagerRunner;

	/**
	 * @param cwd - the project directory a project-scoped install resolves against.
	 * @param run - the package-manager seam. Injectable because the rollback's
	 * repair step is defined by the arguments it runs the manager with, which is
	 * only observable from outside this module.
	 */
	constructor(cwd: string = getProjectDir(), run: PackageManagerRunner = runPackageManager) {
		this.#cwd = cwd;
		this.#run = run;
	}

	/** Run the package manager through this manager's seam. */
	#packageManager(
		argv: readonly string[],
		options: { onOutput?: (chunk: InstallOutputChunk) => void; signal?: AbortSignal } = {},
	): Promise<{ exitCode: number; stdoutTail: string; stderrTail: string }> {
		return this.#run(argv, getPluginsDir(), options);
	}

	// ==========================================================================
	// Runtime Config Management
	// ==========================================================================

	async #loadRuntimeConfig(): Promise<PluginRuntimeConfig> {
		const lockPath = getPluginsLockfile();
		try {
			return normalizePluginRuntimeConfig(await Bun.file(lockPath).json());
		} catch (err) {
			if (isEnoent(err)) return normalizePluginRuntimeConfig({});
			logger.warn("Failed to load plugin runtime config", { path: lockPath, error: String(err) });
			return normalizePluginRuntimeConfig({});
		}
	}

	async #ensureConfigLoaded(): Promise<PluginRuntimeConfig> {
		if (!this.#runtimeConfig) {
			this.#runtimeConfig = await this.#loadRuntimeConfig();
		}
		return this.#runtimeConfig;
	}

	async #saveRuntimeConfig(): Promise<void> {
		await this.#ensureConfigLoaded();
		await Bun.write(getPluginsLockfile(), JSON.stringify(this.#runtimeConfig, null, 2));
	}

	async #loadProjectOverrides(): Promise<ProjectPluginOverrides> {
		const overridesPath = getProjectPluginOverridesPath(this.#cwd);
		try {
			return await Bun.file(overridesPath).json();
		} catch (err) {
			if (isEnoent(err)) return {};
			logger.warn("Failed to load project plugin overrides", { path: overridesPath, error: String(err) });
			return {};
		}
	}

	// ==========================================================================
	// Directory Management
	// ==========================================================================

	async #ensurePluginsDir(): Promise<void> {
		await fs.promises.mkdir(getPluginsDir(), { recursive: true });
		await fs.promises.mkdir(getPluginsNodeModules(), { recursive: true });
	}

	async #ensurePackageJson(): Promise<void> {
		const pkgJsonPath = getPluginsPackageJson();
		try {
			await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				await Bun.write(
					pkgJsonPath,
					JSON.stringify(
						{
							name: "musepi-plugins",
							private: true,
							dependencies: {},
						},
						null,
						2,
					),
				);
				return;
			}
			throw err;
		}
	}

	/**
	 * Read the `dependencies` map from `plugins/package.json`. Returns an empty
	 * object when the file does not exist yet so callers can diff `before`
	 * against `after` to discover the package bun just installed under its
	 * real name (git specs do not encode the package name in the spec itself).
	 */
	async #readDeps(pkgJsonPath: string): Promise<Record<string, string>> {
		try {
			const json = await Bun.file(pkgJsonPath).json();
			return (json.dependencies as Record<string, string>) ?? {};
		} catch (err) {
			if (isEnoent(err)) return {};
			throw err;
		}
	}

	async #removeDependencyEntry(pkgJsonPath: string, name: string): Promise<void> {
		const pkgJson: { dependencies?: Record<string, string>; [key: string]: unknown } =
			await Bun.file(pkgJsonPath).json();
		if (!pkgJson.dependencies || !(name in pkgJson.dependencies)) {
			return;
		}
		delete pkgJson.dependencies[name];
		await Bun.write(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
	}

	#collectInstalledNames(deps: Record<string, string>, config: PluginRuntimeConfig): Set<string> {
		const installedNames = new Set<string>();
		for (const name of Object.keys(deps)) {
			installedNames.add(name);
		}
		for (const name of Object.keys(config.plugins)) {
			installedNames.add(name);
		}
		return installedNames;
	}
	async #collectMarketplaceRuntimePackageRealpaths(): Promise<Map<string, Set<string>>> {
		const registry = await readInstalledPluginsRegistry(getInstalledPluginsRegistryPath());
		const packageRealpaths = new Map<string, Set<string>>();
		await Promise.all(
			Object.entries(registry.plugins).flatMap(([pluginId, entries]) =>
				entries.map(async entry => {
					// Legacy registries written before `scope` was added omit the field;
					// `listClaudePluginRoots` treats those as user-scoped, so do the same.
					if ((entry.scope ?? "user") !== "user") return;
					const packageJsonPath = path.join(entry.installPath, "package.json");
					const parsedId = parsePluginId(pluginId);
					let packageName = parsedId?.name ?? pluginId;
					try {
						const pkg: RuntimePackageJson = await Bun.file(packageJsonPath).json();
						if (typeof pkg.name === "string" && pkg.name.length > 0) {
							packageName = pkg.name;
						}
					} catch (err) {
						if (!isEnoent(err)) {
							logger.debug("Failed to inspect marketplace plugin package path", {
								path: entry.installPath,
								error: String(err),
							});
							return;
						}
					}

					try {
						const installRealpath = await fs.promises.realpath(entry.installPath);
						const realpaths = packageRealpaths.get(packageName) ?? new Set<string>();
						realpaths.add(installRealpath);
						packageRealpaths.set(packageName, realpaths);
					} catch (err) {
						if (isEnoent(err)) return;
						throw err;
					}
				}),
			),
		);
		return packageRealpaths;
	}

	async #isMarketplaceRuntimeLink(
		name: string,
		deps: Record<string, string>,
		marketplaceRuntimeRealpaths: Map<string, Set<string>>,
		pluginPath: string,
	): Promise<boolean> {
		if (name in deps) return false;
		const realpaths = marketplaceRuntimeRealpaths.get(name);
		if (!realpaths) return false;
		try {
			return realpaths.has(await fs.promises.realpath(pluginPath));
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	}

	async #snapshotInstalledPackage(actualName: string | undefined): Promise<PluginPackageSnapshot | null> {
		if (!actualName) {
			return null;
		}
		const packagePath = path.join(getPluginsNodeModules(), actualName);
		try {
			await fs.promises.lstat(packagePath);
		} catch (err) {
			if (isEnoent(err)) {
				return null;
			}
			throw err;
		}

		const backupRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-plugin-backup-"));
		const backupPath = path.join(backupRoot, "package");
		await fs.promises.cp(packagePath, backupPath, { recursive: true, verbatimSymlinks: true });
		return { actualName, packagePath, backupRoot, backupPath };
	}

	async #cleanupSnapshot(snapshot: PluginPackageSnapshot | null): Promise<void> {
		if (!snapshot) {
			return;
		}
		try {
			await fs.promises.rm(snapshot.backupRoot, { recursive: true, force: true });
		} catch (err) {
			logger.warn("Failed to remove plugin install backup", { plugin: snapshot.actualName, error: String(err) });
		}
	}

	async #rollbackFailedInstall(
		actualName: string | undefined,
		packageJsonBefore: string,
		bunLockBefore: string | null,
		snapshot: PluginPackageSnapshot | null,
	): Promise<void> {
		await Bun.write(getPluginsPackageJson(), packageJsonBefore);

		// Restore (or remove) bun's lockfile. Without this, a `bun install` +
		// `bun update` pair that successfully rewrote `bun.lock` would leave the
		// rejected commit pinned even when validation rolls everything else back.
		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		if (bunLockBefore === null) {
			await fs.promises.rm(bunLockPath, { force: true });
		} else {
			await Bun.write(bunLockPath, bunLockBefore);
		}

		// `actualName` may be undefined when the install failed before the dep
		// key was resolved. Either way the tree was rewritten by the package
		// manager, so the repair runs on every path.
		try {
			if (actualName) {
				const packagePath = path.join(getPluginsNodeModules(), actualName);
				await fs.promises.rm(packagePath, { recursive: true, force: true });
				if (snapshot) {
					await fs.promises.mkdir(path.dirname(snapshot.packagePath), { recursive: true });
					await fs.promises.cp(snapshot.backupPath, snapshot.packagePath, {
						recursive: true,
						verbatimSymlinks: true,
					});
				}
			}
		} finally {
			await this.#repairNodeModulesAfterRollback(bunLockBefore);
		}
	}

	/**
	 * Put `node_modules` back in step with the restored manifest.
	 *
	 * Restoring the manifest, the lockfile, and the one package directory above
	 * is not the same as restoring what is installed. A `bun install` writes the
	 * whole dependency tree: it can hoist, deduplicate, or replace a transitive
	 * dependency of a plugin that was already installed and had nothing to do
	 * with this run. That plugin's directory is not in the snapshot, so after the
	 * restore the manifest and the lockfile both describe the pre-run state while
	 * the tree on disk is a mixture of the two, and the next boot loads against
	 * whatever that mixture resolves to.
	 *
	 * Running the package manager once more against the restored files repairs
	 * the tree. Which flag depends on what was restored: a run that had a
	 * lockfile gets `--frozen-lockfile`, so the install reproduces the restored
	 * lock rather than resolving anything new; a run that had none gets
	 * `--no-save`, which installs what the restored manifest asks for without
	 * writing a manifest or creating the lockfile this run did not have.
	 *
	 * A repair that fails is logged rather than thrown. The restored files are
	 * already correct, the caller is already reporting the failure that sent it
	 * here, and replacing that message with a repair failure would hide the
	 * reason the install was rolled back.
	 */
	async #repairNodeModulesAfterRollback(bunLockBefore: string | null): Promise<void> {
		const args = bunLockBefore === null ? ["bun", "install", "--no-save"] : ["bun", "install", "--frozen-lockfile"];
		try {
			const run = await this.#packageManager(args);
			if (run.exitCode !== 0) {
				logger.warn("Plugin rollback could not reinstall node_modules from the restored files", {
					exitCode: run.exitCode,
					detail: run.stderrTail.trim() || run.stdoutTail.trim(),
				});
			}
		} catch (err) {
			logger.warn("Plugin rollback could not reinstall node_modules from the restored files", {
				error: String(err),
			});
		}
	}

	async #validateInstalledExtensions(plugin: InstalledPlugin): Promise<void> {
		const declaredEntries = resolvePluginManifestEntries(plugin, "extensions");
		if (declaredEntries.length === 0) {
			return;
		}

		const errors: string[] = [];
		const loadable: string[] = [];
		for (const { entry, resolvedPath } of declaredEntries) {
			if (resolvedPath === null) {
				errors.push(`${entry}: declared extension entry not found on disk`);
			} else {
				loadable.push(resolvedPath);
			}
		}

		if (loadable.length > 0) {
			const result = await loadExtensions(loadable, this.#cwd);
			for (const failure of result.errors) {
				errors.push(`${failure.path}: ${failure.error}`);
			}
		}

		if (errors.length > 0) {
			throw new Error(`Plugin ${plugin.name} extension validation failed:\n${errors.join("\n")}`);
		}
	}

	// ==========================================================================
	// Install / Uninstall
	// ==========================================================================

	/**
	 * Install a plugin with optional feature selection.
	 *
	 * Accepts:
	 * - npm specs: `pkg`, `pkg@1.2.3`, `@scope/pkg`, `pkg[features]`
	 * - namespaced git shorthand: `github:user/repo[#ref]`, `gitlab:`, `bitbucket:`,
	 *   `codeberg:`, `sourcehut:`/`srht:`
	 * - full git URLs: `https://github.com/user/repo`, `git@github.com:user/repo`,
	 *   `ssh://…`, `git+https://…`
	 *
	 * For git specs the package name is not knowable from the spec, so the
	 * installer diffs `plugins/package.json` `dependencies` before and after
	 * to find the newly added key.
	 *
	 * @param specString - Package specifier with optional features: "pkg", "pkg[feat]", "pkg[*]", "pkg[]"
	 * @param options - Install options
	 * @returns Installed plugin metadata
	 */
	/**
	 * Enable or disable an installed plugin by toggling its runtime-config
	 * `enabled` flag in `musepi-plugins.lock.json`. Calling with
	 * `enabled=true` creates the lock entry if absent (fresh install default
	 * is enabled). Returns the new state.
	 */
	async setPluginEnabled(name: string, enabled: boolean): Promise<boolean> {
		await this.#ensureConfigLoaded();
		const existing = this.#runtimeConfig!.plugins[name];
		this.#runtimeConfig!.plugins[name] = {
			enabled,
			version: existing?.version ?? "0.0.0",
			enabledFeatures: existing?.enabledFeatures ?? null,
		};
		await this.#saveRuntimeConfig();
		return enabled;
	}

	async install(specString: string, options: InstallOptions = {}): Promise<InstalledPlugin> {
		const spec = parsePluginSpec(specString);
		const classification = parseInstallSpec(spec.packageName);
		const gitSource = parseGitUrl(spec.packageName);
		if (gitSource) {
			validateGitSpec(spec.packageName);
		} else if (classification.kind === "registry") {
			validatePackageName(spec.packageName);
		}
		options.signal?.throwIfAborted();

		await this.#ensurePackageJson();

		if (options.dryRun) {
			return {
				name: spec.packageName,
				version: "0.0.0-dryrun",
				path: "",
				manifest: { version: "0.0.0-dryrun" },
				enabledFeatures: spec.features === "*" ? null : (spec.features as string[] | null),
				enabled: true,
			};
		}
		const pkgJsonPath = getPluginsPackageJson();
		const packageJsonBefore = await Bun.file(pkgJsonPath).text();
		// Snapshot bun's lockfile so the rollback path can restore the pin. Every
		// step below — `bun install`, `bun update`, feature/extension validation,
		// runtime-config save — must either complete entirely or leave the
		// lockfile pointing at its pre-install state. Absent before install means
		// "remove on rollback".
		const bunLockPath = path.join(getPluginsDir(), "bun.lock");
		let bunLockBefore: string | null;
		try {
			bunLockBefore = await Bun.file(bunLockPath).text();
		} catch (err) {
			if (!isEnoent(err)) throw err;
			bunLockBefore = null;
		}
		const depsBefore = await this.#readDeps(pkgJsonPath);
		const { installSpec: packageInstallSpec, specNamesPackage } = installSpecFor(classification);
		const existingActualName = gitSource
			? findGitPackageName(gitSource, depsBefore)
			: specNamesPackage
				? extractPackageName(spec.packageName)
				: undefined;
		const packageSnapshot = await this.#snapshotInstalledPackage(existingActualName);

		// `actualName` is hoisted so the rollback handler can clean up the right
		// node_modules entry even if a step between `bun install` and the final
		// validation throws.
		let actualName: string | undefined;
		try {
			// Bun treats a dependency replacement from `repo#old-ref` to the same
			// package at `repo`/`repo#new-ref` as a self-edge and bails with
			// DependencyLoop. Remove only the stale manifest edge; rollback restores
			// the original package.json and node_modules snapshot on failure.
			if (gitSource && existingActualName) {
				const installedSource = parseGitUrl(depsBefore[existingActualName] ?? "");
				if (installedSource && installedSource.ref !== gitSource.ref) {
					await this.#removeDependencyEntry(pkgJsonPath, existingActualName);
				}
			}

			// Step 1: write the spec into plugins/package.json + node_modules.
			const installRun = await this.#packageManager(["bun", "install", packageInstallSpec], {
				onOutput: options.onOutput,
				signal: options.signal,
			});
			// A cancelled run is a different outcome from a failing one, and the
			// GUI reads them differently. Check the signal before the exit code:
			// killing the process always leaves a non-zero status, which would
			// otherwise report a cancellation as a package-manager failure.
			options.signal?.throwIfAborted();
			if (installRun.exitCode !== 0) {
				throw new Error(
					`bun install failed: ${installRun.stderrTail.trim() || installRun.stdoutTail.trim() || `exit code ${installRun.exitCode}`}`,
				);
			}
			// Resolve the actual package name. A registry spec encodes the name (strip
			// the version), so it is known before the run. Every other source — git,
			// tarball, local path — is written into plugins/package.json under whatever
			// name the installed package declares, so the only source of truth is a
			// diff of the dependency map across the install.
			if (specNamesPackage) {
				actualName = extractPackageName(spec.packageName);
			} else {
				const depsAfter = await this.#readDeps(pkgJsonPath);
				let resolved: string | undefined;
				for (const key of Object.keys(depsAfter)) {
					if (!(key in depsBefore)) {
						resolved = key;
						break;
					}
				}
				// Fallback: re-installing a source that is already present adds no
				// key, it only rewrites the existing one to the new spec value. A git
				// spec is then matched by repository identity, so a failed upgrade
				// from one ref to another still resolves to the original name.
				if (!resolved && gitSource) {
					resolved = findGitPackageName(gitSource, depsAfter);
				}
				if (!resolved) {
					throw new Error(
						`Installed ${spec.packageName} but could not determine package name from plugins/package.json`,
					);
				}
				actualName = resolved;
			}

			// Step 2: refresh the git lockfile pin when re-installing an existing
			// git plugin. `bun install <spec>` is a no-op when the spec matches the
			// lockfile entry, while `bun update <name>` resolves through Bun's bare
			// clone cache. Fetch the matching cache clone first so a stale cached
			// ref cannot silently preserve the old pin (#3063, #5401). First-time
			// installs skip this because the initial `bun install` populated the
			// cache from the remote. Rollback is handled by the outer catch.
			if (gitSource && existingActualName) {
				await refreshBunGitCache(gitSource, getPluginsDir());
				const updateRun = await this.#packageManager(["bun", "update", actualName], {
					onOutput: options.onOutput,
					signal: options.signal,
				});
				options.signal?.throwIfAborted();
				if (updateRun.exitCode !== 0) {
					throw new Error(
						`bun update ${actualName} failed: ${updateRun.stderrTail.trim() || updateRun.stdoutTail.trim() || `exit code ${updateRun.exitCode}`}`,
					);
				}
			}

			const pkgPath = path.join(getPluginsNodeModules(), actualName, "package.json");
			let pkg: { name: string; version: string; musepi?: PluginManifest; omp?: PluginManifest; pi?: PluginManifest };
			try {
				pkg = await Bun.file(pkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					throw new Error(`Package installed but package.json not found at ${pkgPath}`);
				}
				throw err;
			}
			const manifest: PluginManifest = (readPluginBlock(pkg) as PluginManifest | undefined) ?? {
				version: pkg.version,
			};
			manifest.version = pkg.version;

			// Resolve enabled features
			let enabledFeatures: string[] | null = null;
			if (spec.features === "*") {
				// All features
				enabledFeatures = manifest.features ? Object.keys(manifest.features) : null;
			} else if (Array.isArray(spec.features)) {
				if (spec.features.length > 0) {
					// Validate requested features exist
					if (manifest.features) {
						for (const feat of spec.features) {
							if (!(feat in manifest.features)) {
								throw new Error(
									`Unknown feature "${feat}" in ${actualName}. Available: ${Object.keys(manifest.features).join(", ")}`,
								);
							}
						}
					}
					enabledFeatures = spec.features;
				} else {
					// Empty array = no optional features
					enabledFeatures = [];
				}
			}
			// null = use defaults

			const installedPlugin: InstalledPlugin = {
				name: pkg.name,
				version: pkg.version,
				path: path.join(getPluginsNodeModules(), actualName),
				manifest,
				enabledFeatures,
				enabled: true,
			};

			await this.#validateInstalledExtensions(installedPlugin);

			// Update runtime config
			const config = await this.#ensureConfigLoaded();
			config.plugins[pkg.name] = {
				version: pkg.version,
				enabledFeatures,
				enabled: true,
			};
			await this.#saveRuntimeConfig();

			return installedPlugin;
		} catch (err) {
			// Every exit from here — a package-manager failure, a rejected spec, a
			// validation failure, or a cancellation — restores the manifest,
			// lockfile, and node_modules entry captured above. The rollback runs
			// first so the person never sees a cancelled install reported as a
			// failure, and so a cancellation leaves no half-installed dependency.
			try {
				await this.#rollbackFailedInstall(
					actualName ?? existingActualName,
					packageJsonBefore,
					bunLockBefore,
					packageSnapshot,
				);
			} catch (rollbackErr) {
				const message = err instanceof Error ? err.message : String(err);
				const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
				throw new Error(`${message}\nRollback failed: ${rollbackMessage}`);
			}
			// The signal is the authority on cancellation, not the thrown error: a
			// kill during rollback reports a rollback failure, and a package manager
			// that failed on its own while the person pressed cancel should still
			// read as the cancellation they asked for.
			if (options.signal?.aborted) {
				throw new InstallAbortedError(spec.packageName);
			}
			throw err;
		} finally {
			await this.#cleanupSnapshot(packageSnapshot);
		}
	}

	/**
	 * Uninstall a plugin.
	 *
	 * Shares {@link runPackageManager} with the install path so the failure
	 * message carries what bun actually said. Discarding the streams here — as
	 * this path used to — reports "uninstall failed" with no reason attached,
	 * which for a name the registry no longer carries is indistinguishable from
	 * a lockfile or permission problem.
	 */
	async uninstall(name: string): Promise<void> {
		validatePackageName(name);
		await this.#ensurePackageJson();

		const run = await this.#packageManager(["bun", "uninstall", name]);
		if (run.exitCode !== 0) {
			const detail = run.stderrTail.trim() || run.stdoutTail.trim() || `exit code ${run.exitCode}`;
			throw new Error(`bun uninstall ${name} failed: ${detail}`);
		}

		// Remove from runtime config
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
	}

	/**
	 * List all installed plugins.
	 */
	async list(): Promise<InstalledPlugin[]> {
		const pkgJsonPath = getPluginsPackageJson();
		let deps: Record<string, string> = {};
		try {
			const pkg: { dependencies?: Record<string, string> } = await Bun.file(pkgJsonPath).json();
			deps = pkg.dependencies ?? {};
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		const [projectOverrides, config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#loadProjectOverrides(),
			this.#ensureConfigLoaded(),
			this.#collectMarketplaceRuntimePackageRealpaths(),
		]);
		const plugins: InstalledPlugin[] = [];
		const installedNames = this.#collectInstalledNames(deps, config);
		for (const name of installedNames) {
			const pluginPath = path.join(getPluginsNodeModules(), name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const pluginPkgPath = path.join(pluginPath, "package.json");
			let pluginPkg: { version: string; musepi?: PluginManifest; omp?: PluginManifest; pi?: PluginManifest };
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			const manifest: PluginManifest = (readPluginBlock(pluginPkg) as PluginManifest | undefined) ?? {
				version: pluginPkg.version,
			};
			manifest.version = pluginPkg.version;

			const runtimeState = config.plugins[name] || {
				version: pluginPkg.version,
				enabledFeatures: null,
				enabled: true,
			};

			const isDisabledInProject = projectOverrides.disabled?.includes(name) ?? false;
			const projectFeatures = projectOverrides.features?.[name];

			plugins.push({
				name,
				version: pluginPkg.version,
				path: pluginPath,
				manifest,
				enabledFeatures: projectFeatures ?? runtimeState.enabledFeatures,
				enabled: runtimeState.enabled && !isDisabledInProject,
			});
		}

		return plugins;
	}

	/**
	 * Link a local plugin for development.
	 */
	async link(localPath: string): Promise<InstalledPlugin> {
		const absolutePath = path.resolve(this.#cwd, localPath);

		const pkgFilePath = path.join(absolutePath, "package.json");
		let pkg: { name?: string; version: string; musepi?: PluginManifest; omp?: PluginManifest; pi?: PluginManifest };
		try {
			pkg = await Bun.file(pkgFilePath).json();
		} catch (err) {
			if (isEnoent(err)) throw new Error(`package.json not found at ${absolutePath}`);
			throw err;
		}
		if (!pkg.name) {
			throw new Error("package.json must have a name field");
		}

		await this.#ensurePluginsDir();

		const linkPath = path.join(getPluginsNodeModules(), pkg.name);

		// Handle scoped packages
		if (pkg.name.startsWith("@")) {
			const scopeDir = path.join(getPluginsNodeModules(), pkg.name.split("/")[0]);
			await fs.promises.mkdir(scopeDir, { recursive: true });
		}

		// Remove existing
		try {
			const stats = await fs.promises.lstat(linkPath);
			if (stats.isSymbolicLink() || stats.isDirectory()) {
				await fs.promises.unlink(linkPath);
			}
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}

		await fs.promises.symlink(absolutePath, linkPath);

		const manifest: PluginManifest = (readPluginBlock(pkg) as PluginManifest | undefined) ?? { version: pkg.version };
		manifest.version = pkg.version;

		// Add to runtime config
		const config = await this.#ensureConfigLoaded();
		config.plugins[pkg.name] = {
			version: pkg.version,
			enabledFeatures: null,
			enabled: true,
		};
		await this.#saveRuntimeConfig();

		return {
			name: pkg.name,
			version: pkg.version,
			path: absolutePath,
			manifest,
			enabledFeatures: null,
			enabled: true,
		};
	}

	// ==========================================================================
	// Enable / Disable
	// ==========================================================================

	/**
	 * Enable or disable a plugin globally.
	 */
	async setEnabled(name: string, enabled: boolean): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}
		config.plugins[name].enabled = enabled;
		await this.#saveRuntimeConfig();
	}

	// ==========================================================================
	// Features
	// ==========================================================================

	/**
	 * Get enabled features for a plugin.
	 */
	async getEnabledFeatures(name: string): Promise<string[] | null> {
		const config = await this.#ensureConfigLoaded();
		return config.plugins[name]?.enabledFeatures ?? null;
	}

	/**
	 * Set enabled features for a plugin.
	 */
	async setEnabledFeatures(name: string, features: string[] | null): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.plugins[name]) {
			throw new Error(`Plugin ${name} not found in runtime config`);
		}

		// Validate features if setting specific ones
		if (features && features.length > 0) {
			const plugins = await this.list();
			const plugin = plugins.find(p => p.name === name);
			if (plugin?.manifest.features) {
				for (const feat of features) {
					if (!(feat in plugin.manifest.features)) {
						throw new Error(
							`Unknown feature "${feat}" in ${name}. Available: ${Object.keys(plugin.manifest.features).join(", ")}`,
						);
					}
				}
			}
		}

		config.plugins[name].enabledFeatures = features;
		await this.#saveRuntimeConfig();
	}

	// ==========================================================================
	// Settings
	// ==========================================================================

	/**
	 * Get all settings for a plugin.
	 */
	async getPluginSettings(name: string): Promise<Record<string, unknown>> {
		const config = await this.#ensureConfigLoaded();
		const global = config.settings[name] || {};
		const projectOverrides = await this.#loadProjectOverrides();
		const project = projectOverrides.settings?.[name] || {};

		// Project settings override global
		return { ...global, ...project };
	}

	/**
	 * Set a plugin setting value.
	 */
	async setPluginSetting(name: string, key: string, value: unknown): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (!config.settings[name]) {
			config.settings[name] = {};
		}
		config.settings[name][key] = value;
		await this.#saveRuntimeConfig();
	}

	/**
	 * Delete a plugin setting.
	 */
	async deletePluginSetting(name: string, key: string): Promise<void> {
		const config = await this.#ensureConfigLoaded();
		if (config.settings[name]) {
			delete config.settings[name][key];
			await this.#saveRuntimeConfig();
		}
	}

	// ==========================================================================
	// Doctor
	// ==========================================================================

	/**
	 * Run health checks on the plugin system.
	 */
	async doctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
		const checks: DoctorCheck[] = [];

		// Check 1: Plugins directory exists
		const pluginsDir = getPluginsDir();
		const pluginsDirExists = fs.existsSync(pluginsDir);
		checks.push({
			name: "plugins_directory",
			status: pluginsDirExists ? "ok" : "warning",
			message: pluginsDirExists ? `Found at ${pluginsDir}` : "Not created yet",
		});

		// Check 2: package.json exists
		const pkgJsonPath = getPluginsPackageJson();
		let pkg: { dependencies?: Record<string, string> };
		let hasPkgJson = true;
		try {
			pkg = await Bun.file(pkgJsonPath).json();
		} catch (err) {
			if (isEnoent(err)) {
				hasPkgJson = false;
				pkg = {};
			} else {
				throw err;
			}
		}
		checks.push({
			name: "package_manifest",
			status: hasPkgJson ? "ok" : "warning",
			message: hasPkgJson ? "Found" : "Not created yet",
		});

		// Check 3: node_modules exists
		const nodeModulesPath = getPluginsNodeModules();
		const hasNodeModules = fs.existsSync(nodeModulesPath);
		checks.push({
			name: "node_modules",
			status: hasNodeModules ? "ok" : hasPkgJson ? "error" : "warning",
			message: hasNodeModules ? "Found" : "Missing (run npm install in plugins dir)",
		});

		const deps = pkg.dependencies || {};
		const [config, marketplaceRuntimeRealpaths] = await Promise.all([
			this.#ensureConfigLoaded(),
			this.#collectMarketplaceRuntimePackageRealpaths(),
		]);
		const installedNames = this.#collectInstalledNames(deps, config);

		for (const name of installedNames) {
			const pluginPath = path.join(nodeModulesPath, name);
			if (await this.#isMarketplaceRuntimeLink(name, deps, marketplaceRuntimeRealpaths, pluginPath)) continue;
			const pluginPkgPath = path.join(pluginPath, "package.json");
			const fromDependencies = name in deps;

			let pluginPkg: {
				version: string;
				description?: string;
				musepi?: PluginManifest;
				omp?: PluginManifest;
				pi?: PluginManifest;
			};
			try {
				pluginPkg = await Bun.file(pluginPkgPath).json();
			} catch (err) {
				if (isEnoent(err)) {
					if (!fs.existsSync(pluginPath)) {
						if (fromDependencies) {
							const fixed = options.fix ? await this.#fixMissingPlugin() : false;
							checks.push({
								name: `plugin:${name}`,
								status: "error",
								message: "Missing from node_modules",
								fixed,
							});
						} else {
							const fixed = options.fix ? await this.#removeOrphanedConfig(name) : false;
							checks.push({
								name: `orphan:${name}`,
								status: "warning",
								message: "Plugin in config but not installed",
								fixed,
							});
						}
					} else {
						checks.push({
							name: `plugin:${name}`,
							status: "error",
							message: "Missing package.json",
						});
					}
					continue;
				}
				throw err;
			}
			const manifest = readPluginBlock(pluginPkg) as PluginManifest | undefined;
			const hasManifest = manifest !== undefined;

			checks.push({
				name: `plugin:${name}`,
				status: hasManifest ? "ok" : "warning",
				message: hasManifest
					? `v${pluginPkg.version}${pluginPkg.description ? ` - ${pluginPkg.description}` : ""}`
					: `v${pluginPkg.version} - No musepi/omp/pi manifest (not a musepi plugin)`,
			});

			// Check tools path exists if specified
			if (manifest?.tools) {
				const toolsPath = path.join(pluginPath, manifest.tools);
				if (!fs.existsSync(toolsPath)) {
					checks.push({
						name: `plugin:${name}:tools`,
						status: "error",
						message: `Tools entry "${manifest.tools}" not found`,
					});
				}
			}

			// Check hooks path exists if specified
			if (manifest?.hooks) {
				const hooksPath = path.join(pluginPath, manifest.hooks);
				if (!fs.existsSync(hooksPath)) {
					checks.push({
						name: `plugin:${name}:hooks`,
						status: "error",
						message: `Hooks entry "${manifest.hooks}" not found`,
					});
				}
			}

			// Check extension entry paths exist if specified
			if (manifest?.extensions) {
				for (const extensionPath of manifest.extensions) {
					const resolvedExtensionPath = path.join(pluginPath, extensionPath);
					if (!fs.existsSync(resolvedExtensionPath)) {
						checks.push({
							name: `plugin:${name}:extension:${extensionPath}`,
							status: "error",
							message: `Extension entry "${extensionPath}" not found`,
						});
					}
				}
			}

			// Check enabled features exist in manifest
			const runtimeState = config.plugins[name];
			if (runtimeState?.enabledFeatures && manifest?.features) {
				for (const feat of runtimeState.enabledFeatures) {
					if (!(feat in manifest.features)) {
						const fixed = options.fix ? await this.#removeInvalidFeature(name, feat) : false;
						checks.push({
							name: `plugin:${name}:feature:${feat}`,
							status: "warning",
							message: `Enabled feature "${feat}" not in manifest`,
							fixed,
						});
					}
				}
			}
		}

		return checks;
	}

	async #fixMissingPlugin(): Promise<boolean> {
		try {
			const proc = Bun.spawn(["bun", "install"], {
				cwd: getPluginsDir(),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
			// Drain pipes concurrently with proc.exited; otherwise a chatty
			// bun install can block on a full OS pipe buffer.
			const [exit] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return exit === 0;
		} catch {
			return false;
		}
	}

	async #removeInvalidFeature(name: string, feat: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		const state = config.plugins[name];
		if (state?.enabledFeatures) {
			state.enabledFeatures = state.enabledFeatures.filter(f => f !== feat);
			await this.#saveRuntimeConfig();
			return true;
		}
		return false;
	}

	async #removeOrphanedConfig(name: string): Promise<boolean> {
		const config = await this.#ensureConfigLoaded();
		delete config.plugins[name];
		delete config.settings[name];
		await this.#saveRuntimeConfig();
		return true;
	}
}

// =============================================================================
// Setting Validation
// =============================================================================

export interface ValidationResult {
	valid: boolean;
	error?: string;
}

/**
 * Validate a setting value against its schema.
 */
export function validateSetting(value: unknown, schema: PluginSettingSchema): ValidationResult {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") {
				return { valid: false, error: "Expected string" };
			}
			break;

		case "number":
			if (typeof value !== "number" || Number.isNaN(value)) {
				return { valid: false, error: "Expected number" };
			}
			if (schema.min !== undefined && value < schema.min) {
				return { valid: false, error: `Must be >= ${schema.min}` };
			}
			if (schema.max !== undefined && value > schema.max) {
				return { valid: false, error: `Must be <= ${schema.max}` };
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return { valid: false, error: "Expected boolean" };
			}
			break;

		case "enum":
			if (!schema.values.includes(String(value))) {
				return { valid: false, error: `Must be one of: ${schema.values.join(", ")}` };
			}
			break;
	}

	return { valid: true };
}

/**
 * Parse a string value according to a setting schema's type.
 */
export function parseSettingValue(valueStr: string, schema: PluginSettingSchema): unknown {
	switch (schema.type) {
		case "number":
			return Number(valueStr);

		case "boolean":
			return valueStr === "true" || valueStr === "yes" || valueStr === "1";
		default:
			return valueStr;
	}
}
