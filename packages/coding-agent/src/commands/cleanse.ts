import { postmortem } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runCleanseCommand } from "../cleanse";
import { CliUsageError } from "../cli/usage-error";

export default class Cleanse extends Command {
	static description = "Detect and fix project diagnostics with weighted parallel subagents";

	static flags = {
		agents: Flags.integer({
			char: "n",
			description: "Maximum number of file-disjoint subagents",
			default: 8,
		}),
		model: Flags.string({
			char: "m",
			description: "Subagent model selector",
			default: "@smol",
		}),
		tests: Flags.boolean({
			char: "t",
			description: "Also run configured project test suites",
			default: false,
		}),
	};

	static examples = [
		"omp cleanse",
		"omp cleanse -n 4",
		"omp cleanse -m opus",
		"omp cleanse -t",
		"omp cleanse --agents 12 --model anthropic/claude-opus-4-6",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Cleanse);
		if (flags.agents <= 0) throw new CliUsageError("--agents must be a positive integer");
		const result = await runCleanseCommand({
			maxAgents: flags.agents,
			model: flags.model,
			includeTests: flags.tests,
		});
		await postmortem.quit(result.exitCode);
	}
}
