/**
 * `musepi sessions` — list saved sessions from outside the harness.
 *
 * Headless counterpart to the TUI session picker: prints saved sessions
 * (newest first) with their id, title, cwd, and last-modified time so scripts
 * and CI can enumerate what exists without launching the TUI.
 */

import { APP_NAME } from "@musepi/pi-utils";
import { Command, Flags } from "@musepi/pi-utils/cli";
import { sessionsHelp as commandHelp } from "../cli/command-help";
import { resolveSessionsArgs, runSessionsList } from "../cli/sessions-cli";

export default class Sessions extends Command {
	static description = commandHelp.description;

	static args = {};

	static flags = {
		cwd: Flags.string({
			char: "C",
			description: "Only list sessions whose working directory is this path (default: current directory)",
		}),
		limit: Flags.integer({
			char: "n",
			description: "Print at most n sessions (newest first)",
		}),
		json: Flags.boolean({
			char: "j",
			description: "Emit machine-readable JSON rows",
		}),
		archived: Flags.boolean({
			description: "Include archived sessions (reserved; nothing is archived yet)",
			hidden: true,
		}),
	};

	static examples = [
		`# List every saved session, newest first\n  ${APP_NAME} sessions`,
		`# Only sessions started in the current project directory\n  ${APP_NAME} sessions --cwd .`,
		`# Ten most recent sessions as JSON\n  ${APP_NAME} sessions --limit 10 --json`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Sessions);
		const args = resolveSessionsArgs(
			{
				cwd: flags.cwd,
				limit: flags.limit,
				json: flags.json,
				archived: flags.archived,
			},
			process.cwd(),
		);
		await runSessionsList(args);
	}
}
