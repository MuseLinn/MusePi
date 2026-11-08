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

export const name = "musepi-subagent-claude-code";
export const inject = [] as const;
export const provide = [] as const;

/** Create a strict Claude Code CLI executor without adding an SDK dependency. */
export function createClaudeCodeExecutor(
	config: ExternalProductConfig = {},
	factory?: ExternalProcessFactory,
): ExternalSubagentExecutor {
	return context => {
		const model = externalModel(config.model);
		const command = [
			externalExecutable(config.executable, "claude"),
			"-p",
			externalTask(context.options),
			"--output-format",
			"stream-json",
			"--verbose",
			"--permission-mode",
			config.permissionMode?.trim() || "dontAsk",
			...(model ? ["--model", model] : []),
		];
		return runExternalJsonl(
			context,
			{
				product: "Claude Code",
				command,
				env: externalEnvironment(config.env),
				disposeGraceMs: config.disposeGraceMs,
				requireFinal: true,
				parse: value => parseClaudeStyleEvent("Claude Code", value),
			},
			factory,
		);
	};
}

export function apply(ctx: ExtensionAPI): void {
	ctx.setLabel("实验性 Claude Code 子智能体");
	registerExternalExecutableProbe(ctx, "claude");
	const executor = ctx.config.getAll().then(config => createClaudeCodeExecutor(config));
	ctx.subagents.register({
		name: "claude-code",
		description: "Experimental: delegate a one-shot coding task to the native Claude Code CLI.",
		external: context => executor.then(run => run(context)),
	});
}
