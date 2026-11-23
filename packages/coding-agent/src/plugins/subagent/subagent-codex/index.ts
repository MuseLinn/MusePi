import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import {
	type ExternalProcessFactory,
	type ExternalProductConfig,
	externalEnvironment,
	externalExecutable,
	externalModel,
	externalProductConfigFrom,
	externalTask,
} from "@musepi/pi-coding-agent/task/external-cli";
import { registerExternalExecutableProbe } from "@musepi/pi-coding-agent/task/external-executable-probe";
import type { ExternalSubagentExecutor } from "@musepi/pi-coding-agent/task/types";
import { runCodexAppServer } from "./app-server";

export const name = "musepi-subagent-codex";
export const inject = [] as const;
export const provide = [] as const;

/** Create a one-shot executor for the official Codex app-server protocol. */
export function createCodexExecutor(
	config: ExternalProductConfig = {},
	factory?: ExternalProcessFactory,
): ExternalSubagentExecutor {
	return context =>
		runCodexAppServer(
			context,
			{
				command: [externalExecutable(config.executable, "codex"), "app-server", "--stdio"],
				cwd: context.options.cwd,
				task: externalTask(context.options),
				env: externalEnvironment(config.env),
				model: externalModel(config.model),
				permissionMode: config.permissionMode?.trim() || "never",
				disposeGraceMs: config.disposeGraceMs,
			},
			factory,
		);
}

export function apply(ctx: PluginAPI, config?: Record<string, unknown>): void {
	registerExternalExecutableProbe(ctx, "codex");
	const executor = Promise.resolve(createCodexExecutor(externalProductConfigFrom(config)));
	ctx.subagents.register({
		name: "codex",
		description: "Experimental: delegate a one-shot coding task to the native Codex app-server.",
		external: context => executor.then(run => run(context)),
	});
}
