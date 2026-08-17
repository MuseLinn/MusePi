/**
 * Setup CLI command handler.
 *
 * Handles `omp setup` for onboarding and `omp setup <component>` for optional dependencies.
 */
import * as path from "node:path";
import { APP_NAME, getProjectDir, getPythonEnvDir } from "@musepi/pi-utils";
import chalk from "@musepi/pi-utils/chalk";
import { Settings, settings } from "../config/settings";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { t } from "../i18n/index.ts";
import { theme } from "../modes/theme/theme";
import { downloadSttModel, isSttModelCached } from "../stt/downloader";
import { isSttModelKey, STT_MODEL_OPTIONS } from "../stt/models";
import { downloadTtsModel, isTtsLocalModelKey, isTtsModelCached, TTS_LOCAL_MODEL_OPTIONS } from "../tts";
import { selectSetupModel } from "./setup-model-picker";

export type SetupComponent = "python" | "speech";

export interface SetupCommandArgs {
	component: SetupComponent;
	flags: {
		json?: boolean;
		check?: boolean;
	};
}

const VALID_COMPONENTS: SetupComponent[] = ["python", "speech"];

const MANAGED_PYTHON_ENV = getPythonEnvDir();

/**
 * Parse setup subcommand arguments.
 * Returns undefined if not a setup command.
 */
export function parseSetupArgs(args: string[]): SetupCommandArgs | undefined {
	if (args.length === 0 || args[0] !== "setup") {
		return undefined;
	}

	if (args.length < 2) {
		console.error(chalk.red(t("Usage: {0} setup <component>", APP_NAME)));
		console.error(t("Valid components: {0}", VALID_COMPONENTS.join(", ")));
		process.exit(1);
	}

	const component = args[1];
	if (!VALID_COMPONENTS.includes(component as SetupComponent)) {
		console.error(chalk.red(t("Unknown component: {0}", component)));
		console.error(t("Valid components: {0}", VALID_COMPONENTS.join(", ")));
		process.exit(1);
	}

	const flags: SetupCommandArgs["flags"] = {};
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") {
			flags.json = true;
		} else if (arg === "--check" || arg === "-c") {
			flags.check = true;
		}
	}

	return {
		component: component as SetupComponent,
		flags,
	};
}

interface PythonCheckResult {
	available: boolean;
	pythonPath?: string;
	usingManagedEnv?: boolean;
	managedEnvPath?: string;
}

function managedPythonPath(): string {
	return process.platform === "win32"
		? path.join(MANAGED_PYTHON_ENV, "Scripts", "python.exe")
		: path.join(MANAGED_PYTHON_ENV, "bin", "python");
}

/**
 * Check Python environment and kernel dependencies.
 */
async function checkPythonSetup(cwd: string, interpreter?: string): Promise<PythonCheckResult> {
	const availability = await checkPythonKernelAvailability(cwd, interpreter, { forceProbe: true });
	return {
		available: availability.ok,
		pythonPath: availability.pythonPath,
		usingManagedEnv: availability.pythonPath === managedPythonPath(),
		managedEnvPath: MANAGED_PYTHON_ENV,
	};
}

/**
 * Install Python packages using uv (preferred) or pip.
 */
// Python installation helper removed: the subprocess runner has no Python
// package dependencies beyond a working interpreter. `omp setup python --check`
// remains as a probe; users install optional libs (pandas, matplotlib, ...)
// directly via pip or the in-process `%pip` magic.

/**
 * Run the setup command.
 */
export async function runSetupCommand(cmd: SetupCommandArgs): Promise<void> {
	switch (cmd.component) {
		case "python":
			await handlePythonSetup(cmd.flags);
			break;
		case "speech":
			await handleSpeechSetup(cmd.flags);
			break;
	}
}

async function handlePythonSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	const cwd = getProjectDir();
	const projectSettings = await Settings.init({ cwd });
	const interpreter = projectSettings.get("python.interpreter")?.trim() || undefined;
	const check = await checkPythonSetup(cwd, interpreter);

	if (flags.json) {
		console.log(JSON.stringify(check, null, 2));
		if (!check.available) process.exit(1);
		return;
	}

	if (!check.pythonPath) {
		console.error(chalk.red(`${theme.status.error} ${t("Python not found")}`));
		console.error(chalk.dim(t("Install Python 3.8+ and ensure it's in your PATH")));
		process.exit(1);
	}

	console.log(chalk.dim(t("Python: {0}", check.pythonPath)));
	if (check.usingManagedEnv && check.managedEnvPath) {
		console.log(chalk.dim(t("Using managed environment: {0}", check.managedEnvPath)));
	}

	if (check.available) {
		console.log(chalk.green(`\n${theme.status.success} ${t("Python execution is ready")}`));
		return;
	}

	console.error(chalk.red(`\n${theme.status.error} ${t("Python interpreter reported failure")}`));
	process.exit(1);
}

/**
 * One installable speech dependency. `isReady`/`status` are read-only probes;
 * `pick` (optional) lets an interactive user choose + persist a model; `ensure`
 * performs the download, streaming a normalized progress event.
 */
interface SpeechComponent {
	name: string;
	isReady(): Promise<boolean>;
	status(): Promise<string>;
	pick?(): Promise<boolean>;
	ensure(onProgress: (progress: { stage: string; percent?: number }) => void): Promise<void>;
}

function buildSpeechComponents(): SpeechComponent[] {
	return [
		{
			name: "Speech-to-Text model",
			isReady: () => isSttModelCached(settings.get("stt.modelName")),
			status: async () => {
				const key = settings.get("stt.modelName");
				return (await isSttModelCached(key)) ? key : t("{0} — not downloaded", key);
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					t("Speech-to-Text model"),
					STT_MODEL_OPTIONS.map(({ value, label, description }) => ({
						value,
						label: t(label),
						description: t(description),
					})),
					settings.get("stt.modelName"),
				);
				if (chosen === null) return false;
				if (isSttModelKey(chosen)) {
					settings.set("stt.modelName", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: onProgress =>
				downloadSttModel(settings.get("stt.modelName"), progress =>
					onProgress({ stage: t("Downloading {0} model", progress.label), percent: progress.percent }),
				),
		},
		{
			name: "Text-to-Speech model",
			isReady: () => isTtsModelCached(settings.get("tts.localModel")),
			status: async () => {
				const key = settings.get("tts.localModel");
				return (await isTtsModelCached(key)) ? key : t("{0} — model/runtime not installed", key);
			},
			pick: async () => {
				const chosen = await selectSetupModel(
					t("Text-to-Speech model"),
					TTS_LOCAL_MODEL_OPTIONS.map(({ value, label, description }) => ({
						value,
						label: t(label),
						description: t(description),
					})),
					settings.get("tts.localModel"),
				);
				if (chosen === null) return false;
				if (isTtsLocalModelKey(chosen)) {
					settings.set("tts.localModel", chosen);
					await settings.flush();
				}
				return true;
			},
			ensure: async onProgress => {
				const ok = await downloadTtsModel(settings.get("tts.localModel"), progress =>
					onProgress({ stage: progress.stage, percent: progress.percent }),
				);
				if (!ok) throw new Error(t("Failed to download the local text-to-speech model."));
			},
		},
	];
}

/**
 * Unified `omp setup speech` flow. Drives every {@link SpeechComponent} through
 * one path: report (`--json`/`--check`) or install (interactive pick + ensure
 * with single-line progress; non-TTY skips pickers and installs configured
 * values).
 */
async function handleSpeechSetup(flags: { json?: boolean; check?: boolean }): Promise<void> {
	await Settings.init({ cwd: getProjectDir() });
	const components = buildSpeechComponents();

	if (flags.json) {
		const report: Record<string, { ready: boolean; status: string }> = {};
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			report[component.name] = { ready, status: await component.status() };
		}
		console.log(JSON.stringify(report, null, 2));
		if (!allReady) process.exit(1);
		return;
	}

	if (flags.check) {
		console.log(chalk.bold(t("Speech dependencies:")));
		let allReady = true;
		for (const component of components) {
			const ready = await component.isReady();
			if (!ready) allReady = false;
			const mark = ready ? chalk.green(t("[ok]")) : chalk.yellow(t("[missing]"));
			console.log(`  ${mark} ${t(component.name)}: ${await component.status()}`);
		}
		if (!allReady) process.exit(1);
		return;
	}

	const interactive = Boolean(process.stdout.isTTY);
	for (const component of components) {
		if (interactive && component.pick) {
			await component.pick();
		}
		if (await component.isReady()) {
			console.log(chalk.green(`${theme.status.success} ${t("{0} ready", t(component.name))}`));
			continue;
		}
		console.log(chalk.dim(t("Preparing {0}...", t(component.name))));
		try {
			await component.ensure(progress => {
				const percent = typeof progress.percent === "number" ? ` (${progress.percent}%)` : "";
				process.stdout.write(`\r${chalk.dim(`${t(progress.stage)}${percent}`)}\x1b[K`);
			});
			process.stdout.write("\n");
		} catch (err) {
			process.stdout.write("\n");
			const msg = err instanceof Error ? err.message : t("Failed to set up {0}", t(component.name));
			console.error(chalk.red(`${theme.status.error} ${msg}`));
			process.exit(1);
		}
	}

	console.log(chalk.green(`\n${theme.status.success} ${t("Speech is ready")}`));
	console.log(
		chalk.dim(
			t(
				"Enable speech-to-text via stt.enabled, then hold Space to talk (or bind app.stt.toggle); enable the speech-generation tool via speechgen.enabled; speak replies aloud via speech.enabled.",
			),
		),
	);
}

/**
 * Print setup command help.
 */
export function printSetupHelp(): void {
	console.log(
		`${chalk.bold(`${APP_NAME} setup`)} - ${t("Run onboarding or install dependencies for optional features")}\n\n` +
			`${chalk.bold(t("Usage:"))}\n` +
			`  ${APP_NAME} setup                     ${t("Run the onboarding wizard")}\n` +
			`  ${APP_NAME} setup <component> [options]\n\n` +
			`${chalk.bold(t("Components:"))}\n` +
			`  python    ${t("Verify a Python 3 interpreter is reachable for code execution")}\n` +
			`  speech    ${t("Pick and download speech-to-text and text-to-speech models")}\n\n` +
			`${chalk.bold(t("Options:"))}\n` +
			`  -c, --check   ${t("Check if dependencies are installed without installing")}\n` +
			`  --json        ${t("Output status as JSON")}\n\n` +
			`${chalk.bold(t("Examples:"))}\n` +
			`  ${APP_NAME} setup                  ${t("Run the onboarding wizard")}\n` +
			`  ${APP_NAME} setup python           ${t("Check Python execution dependencies")}\n` +
			`  ${APP_NAME} setup speech           ${t("Pick and download the STT and TTS models")}\n` +
			`  ${APP_NAME} setup speech --check   ${t("Check if speech dependencies are available")}\n` +
			`  ${APP_NAME} setup python --check   ${t("Check if Python execution is available")}\n`,
	);
}
