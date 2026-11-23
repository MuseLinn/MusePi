import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import {
	type ExternalProcessFactory,
	type ExternalProductConfig,
	externalEnvironment,
	externalExecutable,
	externalModel,
	externalTask,
	parseClaudeStyleEvent,
	runExternalJsonl,
} from "@musepi/pi-coding-agent/task/external-cli";
import { registerExternalExecutableProbe } from "@musepi/pi-coding-agent/task/external-executable-probe";
import type { ExternalSubagentExecutor } from "@musepi/pi-coding-agent/task/types";

import type { Config } from "./config";

export { Config } from "./config";

export const name = "musepi-subagent-codebuddy";
export const inject = [] as const;
export const provide = [] as const;

/** Create a CodeBuddy CLI executor with strict native result handling. */
export function createCodeBuddyExecutor(
	config: ExternalProductConfig = {},
	factory?: ExternalProcessFactory,
): ExternalSubagentExecutor {
	return context => {
		const model = externalModel(config.model);
		const command = [
			externalExecutable(config.executable, "codebuddy"),
			"-p",
			externalTask(context.options),
			"--output-format",
			"stream-json",
			"--permission-mode",
			config.permissionMode?.trim() || "dontAsk",
			...(model ? ["--model", model] : []),
		];
		return runExternalJsonl(
			context,
			{
				product: "CodeBuddy",
				command,
				env: externalEnvironment(config.env),
				disposeGraceMs: config.disposeGraceMs,
				requireFinal: true,
				parse: value => parseClaudeStyleEvent("CodeBuddy", value),
			},
			factory,
		);
	};
}

export function apply(ctx: PluginAPI, config?: Config): void {
	registerExternalExecutableProbe(ctx, "codebuddy");
	const executor = Promise.resolve(createCodeBuddyExecutor(config));
	ctx.subagents.register({
		name: "codebuddy",
		description: "Experimental: delegate a one-shot coding task to the native CodeBuddy CLI.",
		external: context => executor.then(run => run(context)),
	});
}
