import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import {
	type ExternalJsonlEvent,
	type ExternalProcessFactory,
	type ExternalProductConfig,
	externalEnvironment,
	externalExecutable,
	externalModel,
	externalProductConfigFrom,
	externalTask,
	runExternalJsonl,
} from "@musepi/pi-coding-agent/task/external-cli";
import { registerExternalExecutableProbe } from "@musepi/pi-coding-agent/task/external-executable-probe";
import type { ExternalSubagentExecutor } from "@musepi/pi-coding-agent/task/types";

export const name = "musepi-subagent-opencode";
export const inject = [] as const;
export const provide = [] as const;

function parseOpenCodeEvent(value: unknown): ExternalJsonlEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as { type?: unknown; part?: { text?: unknown }; error?: { message?: unknown } | string };
	if (event.type === "text" && typeof event.part?.text === "string") return { text: event.part.text };
	if (event.type === "error") {
		const message = typeof event.error === "string" ? event.error : event.error?.message;
		return { error: typeof message === "string" && message ? `OpenCode: ${message}` : "OpenCode failed" };
	}
	return undefined;
}

/** Create an OpenCode CLI executor; non-interactive permission requests remain denied. */
export function createOpenCodeExecutor(
	config: ExternalProductConfig = {},
	factory?: ExternalProcessFactory,
): ExternalSubagentExecutor {
	return context => {
		const model = externalModel(config.model);
		const command = [
			externalExecutable(config.executable, "opencode"),
			"run",
			"--format",
			"json",
			...(model ? ["--model", model] : []),
			externalTask(context.options),
		];
		return runExternalJsonl(
			context,
			{
				product: "OpenCode",
				command,
				env: externalEnvironment(config.env),
				disposeGraceMs: config.disposeGraceMs,
				parse: parseOpenCodeEvent,
			},
			factory,
		);
	};
}

export function apply(ctx: PluginAPI, config?: Record<string, unknown>): void {
	registerExternalExecutableProbe(ctx, "opencode");
	const executor = Promise.resolve(createOpenCodeExecutor(externalProductConfigFrom(config)));
	ctx.subagents.register({
		name: "opencode",
		description: "Experimental: delegate a one-shot coding task to the native OpenCode CLI.",
		external: context => executor.then(run => run(context)),
	});
}
