import type { ExtensionAPI } from "../../extensibility/extensions/types";
import {
	type ExternalProcessFactory,
	type ExternalProductConfig,
	externalEnvironment,
	externalExecutable,
	externalModel,
	externalTask,
	parseClaudeStyleEvent,
	runExternalJsonl,
} from "../../task/external-cli";
import { registerExternalExecutableProbe } from "../../task/external-executable-probe";
import type { ExternalSubagentExecutor } from "../../task/types";

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

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("实验性 CodeBuddy 子智能体");
	registerExternalExecutableProbe(ctx, "codebuddy");
	const executor = ctx.config.getAll().then(config => createCodeBuddyExecutor(config));
	ctx.subagents.register({
		name: "codebuddy",
		description: "Experimental: delegate a one-shot coding task to the native CodeBuddy CLI.",
		external: context => executor.then(run => run(context)),
	});
}
