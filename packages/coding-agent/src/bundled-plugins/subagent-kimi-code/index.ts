import type { ExtensionAPI } from "../../extensibility/extensions/types";
import {
	type ExternalJsonlEvent,
	type ExternalProcessFactory,
	type ExternalProductConfig,
	externalEnvironment,
	externalExecutable,
	externalModel,
	externalTask,
	runExternalJsonl,
} from "../../task/external-cli";
import type { ExternalSubagentExecutor } from "../../task/types";

export const name = "musepi-subagent-kimi-code";
export const inject = [] as const;
export const provide = [] as const;

function parseKimiEvent(value: unknown): ExternalJsonlEvent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const event = value as { role?: unknown; content?: unknown; tool_calls?: unknown };
	if (event.role !== "assistant") return undefined;
	const toolCalls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
	const firstTool = toolCalls[0] as { function?: { name?: unknown; arguments?: unknown } } | undefined;
	return {
		...(typeof event.content === "string" ? { text: event.content } : {}),
		...(typeof firstTool?.function?.name === "string" ? { currentTool: firstTool.function.name } : {}),
		...(typeof firstTool?.function?.arguments === "string" ? { currentToolArgs: firstTool.function.arguments } : {}),
	};
}

/** Create a Kimi Code CLI executor without starting a process at plugin load. */
export function createKimiCodeExecutor(
	config: ExternalProductConfig = {},
	factory?: ExternalProcessFactory,
): ExternalSubagentExecutor {
	return context => {
		const model = externalModel(config.model);
		const command = [
			externalExecutable(config.executable, "kimi"),
			"-p",
			externalTask(context.options),
			"--output-format",
			"stream-json",
			...(model ? ["-m", model] : []),
		];
		return runExternalJsonl(
			context,
			{
				product: "Kimi Code",
				command,
				env: externalEnvironment(config.env),
				disposeGraceMs: config.disposeGraceMs,
				parse: parseKimiEvent,
			},
			factory,
		);
	};
}

export function apply(pi: ExtensionAPI): void {
	pi.setLabel("实验性 Kimi Code 子智能体");
	const executor = pi.config.getAll().then(config => createKimiCodeExecutor(config));
	pi.registerSubagent({
		name: "kimi-code",
		description: "Experimental: delegate a one-shot coding task to the native Kimi Code CLI.",
		external: context => executor.then(run => run(context)),
	});
}

export default apply;
