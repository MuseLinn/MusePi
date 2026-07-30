import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { runBenchCommand } from "../cli/bench-cli";
import { SERVICE_TIER_OPENAI_VALUES } from "../config/service-tier";

export default class Bench extends Command {
	static description =
		"Benchmark models with the same prompt: time-to-first-token and generation throughput (tokens/s)";

	static args = {
		models: Args.string({
			description: "Model selectors (provider/model or fuzzy id, e.g. opus)",
			required: true,
			multiple: true,
		}),
	};

	static flags = {
		runs: Flags.integer({ description: "Requests per model (results are averaged; default: 10)" }),
		"max-tokens": Flags.integer({ description: "Max output tokens per request (default: 512; cache mode: 64)" }),
		prompt: Flags.string({ description: "Custom prompt text (default: bundled bench prompt)" }),
		"service-tier": Flags.string({
			description: "Service tier applied per model family (default: configured `tier.*` settings; `none` omits it)",
			options: SERVICE_TIER_OPENAI_VALUES,
		}),
		json: Flags.boolean({ description: "Output JSON" }),
		par: Flags.integer({ description: "Execute runs with N parallel queries/requests (default: 4)" }),
		cache: Flags.boolean({
			description: "Run independent cold/warm prompt-cache pairs (not supported for openai-codex-responses)",
		}),
		"cache-prefix-file": Flags.string({ description: "Stable prompt prefix file for --cache" }),
		"cache-prefix-bytes": Flags.integer({ description: "Stable prefix byte budget for --cache (default: 8192)" }),
		"cache-pairs": Flags.integer({ description: "Cold/warm pairs per model for --cache (default: 1)" }),
		"cache-concurrency": Flags.integer({
			description: "Concurrent cache pairs for --cache; each pair remains sequential (default: 1)",
		}),
	};

	static examples = [
		"# Compare two models\n  omp bench anthropic/claude-opus-4-5 openai/gpt-5.2",
		"# Fuzzy selectors work\n  omp bench opus sonnet",
		"# Average over 3 runs each\n  omp bench opus gpt-5.2 --runs 3",
		"# Force priority serving tier\n  omp bench openai-codex/gpt-5.5:low --runs 10 --service-tier priority",
		"# Measure one cold/warm prompt-cache pair\n  omp bench openai/gpt-5.6 --cache --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Bench);
		await runBenchCommand({
			models: args.models ?? [],
			flags: {
				runs: flags.runs,
				maxTokens: flags["max-tokens"],
				prompt: flags.prompt,
				serviceTier: flags["service-tier"],
				json: flags.json,
				par: flags.par,
				cache: flags.cache,
				cachePrefixFile: flags["cache-prefix-file"],
				cachePrefixBytes: flags["cache-prefix-bytes"],
				cachePairs: flags["cache-pairs"],
				cacheConcurrency: flags["cache-concurrency"],
			},
		});
	}
}
