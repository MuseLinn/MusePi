/**
 * Run onboarding setup or install dependencies for optional features.
 */

import { Args, Command, Flags, renderCommandHelp } from "@musepi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { t } from "../i18n/index.js";
import { runRootCommand } from "../main";
import { initTheme } from "../modes/theme/theme";

const COMPONENTS: SetupComponent[] = ["python", "speech"];

export interface OnboardingSetupDependencies {
	runRoot?: typeof runRootCommand;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	writeStderr?: (text: string) => void;
	exit?: (code: number) => never;
}

export async function runOnboardingSetup(deps: OnboardingSetupDependencies = {}): Promise<void> {
	const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
	const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY;
	if (!stdinIsTTY || !stdoutIsTTY) {
		(deps.writeStderr ?? (text => process.stderr.write(text)))(`${t("musepi setup requires an interactive TTY.")}\n`);
		(deps.exit ?? process.exit)(1);
		return;
	}
	await (deps.runRoot ?? runRootCommand)(parseArgs([]), [], { forceSetupWizard: true });
}

export default class Setup extends Command {
	// Descriptions and flag help are evaluated lazily (getters) so locale is
	// resolved at help/parse time, never at module load.
	static get description(): string {
		return t("Run onboarding setup or install dependencies for optional features");
	}

	static get args() {
		return {
			component: Args.string({
				description: t("Optional component to install"),
				required: false,
				options: COMPONENTS,
			}),
		};
	}

	static get flags() {
		return {
			check: Flags.boolean({ char: "c", description: t("Check if dependencies are installed") }),
			json: Flags.boolean({ description: t("Output status as JSON") }),
		};
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		if (!args.component) {
			if (flags.check || flags.json) {
				renderCommandHelp("musepi", "setup", Setup);
				return;
			}
			await runOnboardingSetup();
			return;
		}
		const cmd: SetupCommandArgs = {
			component: args.component as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
