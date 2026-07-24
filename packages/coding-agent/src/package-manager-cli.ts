import { rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir, isBunBinary, VERSION } from "./config.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { openBrowser } from "./utils/open-browser.ts";
import {
	applyStagedUpdatePosix,
	backupDirName,
	buildWindowsUpdateScript,
	cleanupStaleUpdateDirs,
	createUpdateWorkDir,
	detectInstallDir,
	downloadReleaseAsset,
	extractReleaseArchive,
	findInstallRoot,
	isDirectoryWritable,
	launchWindowsUpdateScript,
	resolveAssetDownload,
	stageInstallRoot,
	timestampSuffix,
} from "./utils/self-update.ts";
import { getLatestPiRelease, isNewerPackageVersion, MUSEPI_RELEASES_URL } from "./utils/version-check.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string } | { type: "models" };

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	showExtensionsSkippedNote: boolean;
	local: boolean;
	force: boolean;
	yes: boolean;
	checkOnly: boolean;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} update [source|self] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force] [--check] [--yes]`;
		case "list":
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

const CONFIG_COMMAND_USAGE = `${APP_NAME} config [-l] [--approve|--no-approve]`;

function printConfigCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${CONFIG_COMMAND_USAGE}

Open the resource configuration TUI to enable or disable package resources.
Without -l, starts in global settings (~/${CONFIG_DIR_NAME}/agent/settings.json).
Press Tab in the TUI to switch between global and project-local modes.

Options:
  -l, --local       Edit project overrides (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command with -l
  -na, --no-approve Ignore project-local files for this command with -l
`);
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local       Install project-locally (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local       Remove from project settings (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update MusePi, installed packages, or model catalogs.

Options:
  --self                  Update MusePi itself from GitHub Releases (default when no target is given)
  --extensions            Update installed packages only
  --models                Refresh model catalogs only
  --all                   Check MusePi and update installed packages
  --extension <source>    Update one package only
  -a, --approve           Trust project-local files for this command
  -na, --no-approve       Ignore project-local files for this command
  --force                 Reinstall the latest release even if the current version is latest
  --check                 Only check for a new MusePi release; do not download or install
  -y, --yes               Skip the interactive confirmation when self-updating

Short forms:
  ${APP_NAME} update                Update MusePi from GitHub Releases (asks before installing)
  ${APP_NAME} update --check        Only report whether a new MusePi release exists
  ${APP_NAME} update --all          Check MusePi and update all extensions
  ${APP_NAME} update --models       Refresh model catalogs only
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update self           Update MusePi from GitHub Releases
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.

Options:
  -a, --approve      Trust project-local files for this command
  -na, --no-approve  Ignore project-local files for this command
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let yes = false;
	let checkOnly = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let modelsFlag = false;
	let allFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--models") {
			if (command === "update") {
				modelsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--all") {
			if (command === "update") {
				allFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}

		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--yes" || arg === "-y") {
			if (command === "update") {
				yes = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--check") {
			if (command === "update") {
				checkOnly = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	let showExtensionsSkippedNote = false;
	if (command === "update") {
		if (allFlag && (selfFlag || extensionsFlag || modelsFlag || extensionFlagSource)) {
			conflictingOptions =
				conflictingOptions ?? "--all cannot be combined with --self, --extensions, --models, or --extension";
		}
		if (allFlag && source) {
			conflictingOptions = conflictingOptions ?? "--all cannot be combined with a positional source";
		}

		if (modelsFlag) {
			if (selfFlag || extensionsFlag || allFlag || extensionFlagSource) {
				conflictingOptions =
					conflictingOptions ?? "--models cannot be combined with --self, --extensions, --all, or --extension";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--models cannot be combined with a positional source";
			}
			updateTarget = { type: "models" };
		} else if (extensionFlagSource) {
			if (selfFlag || extensionsFlag || allFlag) {
				conflictingOptions =
					conflictingOptions ?? "--extension cannot be combined with --self, --extensions, or --all";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			const sourceIsSelf = source === "self" || source === "pi" || source === "musepi";
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag || allFlag) {
					conflictingOptions =
						conflictingOptions ??
						"positional update targets cannot be combined with --self, --extensions, or --all";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (allFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag && extensionsFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "self" };
			showExtensionsSkippedNote = true;
		}
		if (
			(checkOnly || yes) &&
			updateTarget &&
			(updateTarget.type === "extensions" || updateTarget.type === "models")
		) {
			conflictingOptions =
				conflictingOptions ?? "--check and --yes only apply to MusePi self-updates (--self, self, or --all)";
		}
	}

	return {
		command,
		source,
		updateTarget,
		showExtensionsSkippedNote,
		local,
		force,
		yes,
		checkOnly,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

async function refreshModelCatalogs(agentDir: string): Promise<void> {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const result = await modelRuntime.refresh({
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted) {
			throw new Error("Model catalog refresh timed out.");
		}
		if (result.errors.size > 0) {
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			throw new Error(`Could not refresh model catalogs: ${details}`);
		}
	} finally {
		clearTimeout(timeout);
	}
	console.log(chalk.green("Model catalogs refreshed"));
}

/**
 * MusePi fork: there is no npm package to self-update from (and running the
 * upstream npm self-update would replace MusePi with stock pi). Self-update
 * downloads the platform archive from the fork's GitHub Releases and swaps
 * the install directory (see utils/self-update.ts for the swap strategy).
 * Any step that cannot run automatically falls back to pointing the user at
 * the release page, which is the pre-self-update behavior.
 */
function printManualUpdateFallback(releaseUrl: string): void {
	console.log(`Automatic update is not available for this install.`);
	console.log(`Download the musepi-<platform> archive for your system from:\n  ${releaseUrl}`);
	console.log(`Or reinstall with the one-liner (replaces your existing install):`);
	console.log(`  powershell -c "irm https://muselinn.github.io/MusePi/install.ps1 | iex"`);
	console.log(`  sh -c "$(curl -fsSL https://muselinn.github.io/MusePi/install.sh)"`);
	// Only pop a browser from an interactive terminal — never in CI/scripts.
	if (process.stdout.isTTY) {
		openBrowser(releaseUrl);
	}
}

async function confirmSelfUpdate(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
		return /^(y|yes)$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

function reportDownloadProgress(assetName: string, receivedBytes: number, totalBytes: number | undefined): void {
	const receivedMb = (receivedBytes / 1024 / 1024).toFixed(1);
	if (process.stdout.isTTY) {
		const totalPart = totalBytes ? ` / ${(totalBytes / 1024 / 1024).toFixed(1)} MB` : " MB";
		const percent = totalBytes ? ` ${Math.min(100, Math.floor((receivedBytes / totalBytes) * 100))}%` : "";
		process.stdout.write(`\rDownloading ${assetName} ... ${receivedMb}${totalPart}${percent}   `);
	}
}

async function runSelfUpdate(options: { force: boolean; checkOnly: boolean; yes: boolean }): Promise<void> {
	let latestRelease: Awaited<ReturnType<typeof getLatestPiRelease>>;
	try {
		latestRelease = await getLatestPiRelease(VERSION);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not determine latest ${APP_NAME} version: ${message}`);
	}
	if (!latestRelease) {
		throw new Error(
			`Could not determine latest ${APP_NAME} version (no GitHub release yet, or the channel is unreachable). See ${MUSEPI_RELEASES_URL}`,
		);
	}

	const isNewer = isNewerPackageVersion(latestRelease.version, VERSION);
	if (!options.force && !isNewer) {
		console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
		return;
	}

	const releaseUrl = latestRelease.url ?? MUSEPI_RELEASES_URL;
	if (isNewer) {
		console.log(chalk.yellow(`MusePi update available: ${latestRelease.version} (current: ${VERSION})`));
	} else {
		console.log(`${APP_NAME} v${VERSION} (latest release: ${latestRelease.version})`);
	}

	if (options.checkOnly) {
		console.log(`Release notes and downloads:\n  ${releaseUrl}`);
		return;
	}

	// Self-replacement is only safe for release-archive installs: the binary
	// must live in its own directory next to its package.json. Dev checkouts,
	// npm/bun global installs, etc. fall back to the manual download path.
	if (!isBunBinary) {
		printManualUpdateFallback(releaseUrl);
		return;
	}
	const installDir = detectInstallDir(process.execPath, process.platform);
	if (!installDir) {
		printManualUpdateFallback(releaseUrl);
		return;
	}
	const parentDir = dirname(installDir);
	if (!isDirectoryWritable(parentDir)) {
		console.error(
			chalk.yellow(
				`Install directory ${parentDir} is not writable by this user (a privileged/system-wide install?).`,
			),
		);
		printManualUpdateFallback(releaseUrl);
		return;
	}

	const action = isNewer ? `Update MusePi v${VERSION} -> v${latestRelease.version}` : `Reinstall MusePi v${VERSION}`;
	if (!options.yes) {
		if (!process.stdin.isTTY) {
			console.log(`Non-interactive shell: re-run with --yes to ${isNewer ? "update" : "reinstall"}.`);
			return;
		}
		const confirmed = await confirmSelfUpdate(`${action} in ${installDir}? [y/N] `);
		if (!confirmed) {
			console.log(chalk.dim("Update cancelled."));
			return;
		}
	}

	// Previous backups only matter until the new install proves it works;
	// reaching this point means the current install runs fine.
	cleanupStaleUpdateDirs(installDir);

	const download = resolveAssetDownload(latestRelease, process.platform, process.arch);
	if (!download) {
		console.error(chalk.yellow(`No prebuilt MusePi archive for ${process.platform}/${process.arch}.`));
		printManualUpdateFallback(releaseUrl);
		return;
	}

	const suffix = timestampSuffix();
	const workDir = createUpdateWorkDir();
	try {
		const archivePath = join(workDir, download.assetName);
		await downloadReleaseAsset(download.url, archivePath, (received, total) =>
			reportDownloadProgress(download.assetName, received, total),
		);
		if (process.stdout.isTTY) {
			process.stdout.write("\n");
		}

		const extractDir = join(workDir, "extracted");
		extractReleaseArchive(archivePath, extractDir, download.assetName);
		const installRoot = findInstallRoot(extractDir, process.platform);
		if (!installRoot) {
			throw new Error("Downloaded archive does not contain a valid MusePi install; refusing to update.");
		}

		const stagedDir = stageInstallRoot(installRoot, installDir, suffix);
		if (process.platform === "win32") {
			// Windows cannot move the directory of a running executable, so a
			// detached PowerShell script finishes the swap after this process
			// exits. The script and its log live next to the install dir; the
			// script deletes itself when done.
			const backupDir = backupDirName(installDir, suffix);
			const logFile = join(parentDir, `${basename(installDir)}.update-${suffix}.log`);
			const scriptPath = join(parentDir, `${basename(installDir)}.update-${suffix}.ps1`);
			writeFileSync(
				scriptPath,
				buildWindowsUpdateScript({ installDir, stagedDir, backupDir, logFile, parentPid: process.pid }),
			);
			launchWindowsUpdateScript(scriptPath);
			console.log(
				chalk.green(
					`MusePi v${latestRelease.version} is staged and will be installed as soon as this process exits.`,
				),
			);
			console.log(chalk.dim(`Previous install will be kept at ${backupDir}; update log: ${logFile}`));
			setImmediate(() => process.exit(0));
			return;
		}

		const { backupDir } = await applyStagedUpdatePosix({ installDir, stagedDir, platform: process.platform, suffix });
		console.log(chalk.green(`Updated MusePi to v${latestRelease.version}.`));
		console.log(chalk.dim(`Previous install kept at ${backupDir} until the next update.`));
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

export interface PackageCommandRuntimeOptions {
	extensionFactories?: InlineExtension[];
}

interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

function getCommandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	useSavedProjectTrustOnly?: boolean;
	extensionFactories?: InlineExtension[];
}): Promise<CommandSettingsResult> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const projectTrustWarnings: string[] = [];
	const trustStore = new ProjectTrustStore(options.agentDir);
	if (options.useSavedProjectTrustOnly) {
		const savedProjectTrusted = trustStore.get(options.cwd) === true;
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? savedProjectTrusted);
		return { settingsManager, projectTrustWarnings };
	}

	const appMode = getCommandAppMode();
	const extensionsResult =
		options.projectTrustOverride === undefined && hasTrustRequiringProjectResources(options.cwd)
			? await new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: options.agentDir,
					settingsManager,
					extensionFactories: options.extensionFactories,
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore,
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd,
			mode: appMode,
			settingsManager,
			hasUI: appMode === "interactive",
		}),
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, projectTrustWarnings };
}

export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "config") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}

	let local = false;
	let projectTrustOverride: boolean | undefined;
	for (const arg of rest) {
		if (arg === "-l" || arg === "--local") {
			local = true;
		} else if (arg === "-a" || arg === "--approve") {
			projectTrustOverride = true;
		} else if (arg === "-na" || arg === "--no-approve") {
			projectTrustOverride = false;
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option ${arg} for "config".`));
			console.error(chalk.dim(`Use "${APP_NAME} --help" or "${CONFIG_COMMAND_USAGE}".`));
			process.exitCode = 1;
			return true;
		} else {
			console.error(chalk.red(`Unexpected argument ${arg}.`));
			console.error(chalk.dim(`Usage: ${CONFIG_COMMAND_USAGE}`));
			process.exitCode = 1;
			return true;
		}
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local resource config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "config command");
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const globalResolvedPaths = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
	}).resolve();
	const projectResolvedPaths = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve()
		: globalResolvedPaths;

	await selectConfig({
		resolvedPaths: { global: globalResolvedPaths, project: projectResolvedPaths },
		settingsManager,
		cwd,
		agentDir,
		writeScope: local ? "project" : "global",
		projectModeAvailable: settingsManager.isProjectTrusted(),
	});

	process.exit(0);
}

export async function handlePackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.command === "update" && options.updateTarget?.type === "models") {
		try {
			await refreshModelCatalogs(getAgentDir());
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown model catalog refresh error";
			console.error(chalk.red(`Error: ${message}`));
			process.exitCode = 1;
		}
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		useSavedProjectTrustOnly: options.command === "update",
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local package config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "package command");

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "self" };
				if (options.showExtensionsSkippedNote) {
					console.log(
						chalk.dim(`Extensions are skipped. Run ${APP_NAME} update --extensions to update extensions.`),
					);
				}
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Updated packages"));
					}
				}
				if (updateTargetIncludesSelf(target)) {
					// `--all` is a passive sweep, so it honors musepi.updateCheck=false;
					// an explicit `musepi update` / `update self` always checks.
					if (target.type === "all" && !settingsManager.getMusepi().updateCheck) {
						console.log(
							chalk.dim(
								`MusePi self-update check skipped (musepi.updateCheck=false). Run ${APP_NAME} update to check manually.`,
							),
						);
					} else {
						await runSelfUpdate({ force: options.force, checkOnly: options.checkOnly, yes: options.yes });
					}
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
