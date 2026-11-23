import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolSession } from "./contract";
import { EvalTool } from "./eval";

export const workflowSchema = type({
	name: type("string").describe("Short kebab-case workflow name used in the result envelope."),
	description: type("string").describe("One-line description of what the workflow does.").optional(),
	script: type("string").describe(
		"Plain JavaScript body, not TypeScript, without an `export const meta` statement. Top-level await and return are allowed. Globals: `args` (the args object), `agent(prompt, options)` for subagents, `parallel(thunks)`, `pipeline(items, ...stages)`, `log(message)`, `phase(title)`, `budget`, and `tool.<name>(args)`.",
	),
	args: type("object").describe("Optional JSON object exposed to the script as the `args` global.").optional(),
});

export interface WorkflowToolDetails {
	name: string;
	description?: string;
}

const DEFAULT_MAX_RESULT_CHARS = 50_000;

/**
 * Run a JavaScript orchestration script that fans work out across subagents
 * (dsh's `workflow`). Execution reuses the session's JS eval kernel, so the
 * script has the same `agent()` / `parallel()` / `pipeline()` surface as
 * `eval`; this tool adds the workflow identity and a result ceiling instead of
 * a second sandbox.
 */
export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = "workflow";
	readonly approval = "exec" as const;
	readonly label = "Workflow";
	readonly summary = "Run a JavaScript orchestration across subagents";
	readonly description =
		"Run a model-authored JavaScript workflow that delegates work to subagents and returns the script's value. Use it only when the user explicitly asks for a workflow or for large multi-agent orchestration; prefer one or two plain subagent calls otherwise. The script body runs in the session's JavaScript kernel with `args`, `agent()`, `parallel()`, `pipeline()`, `log()`, `phase()`, `budget` and `tool.<name>()` available. A foreground call waits for every child and returns the final value; a failed or cancelled run reports the failure, never partial success.";
	readonly parameters = workflowSchema;
	readonly loadMode = "essential";

	constructor(
		private readonly session: ToolSession,
		private readonly maxResultChars = DEFAULT_MAX_RESULT_CHARS,
	) {}

	async execute(
		toolCallId: string,
		params: typeof workflowSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		const script = typeof params.script === "string" ? params.script : "";
		if (script.trim() === "") throw new Error("workflow: script must not be empty");
		const code = `globalThis.args = ${JSON.stringify(params.args ?? {})};\n${script}`;
		const result = await new EvalTool(this.session).execute(
			toolCallId,
			{ language: "js", code, title: params.name },
			signal,
			onUpdate,
			ctx,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		const limited =
			text.length > this.maxResultChars
				? `${text.slice(0, this.maxResultChars)}\n… (workflow result truncated at ${this.maxResultChars} characters)`
				: text;
		return {
			content: [{ type: "text", text: limited }],
			details: {
				name: params.name,
				...(typeof params.description === "string" && params.description.trim() !== ""
					? { description: params.description.trim() }
					: {}),
			},
			...(result.isError ? { isError: true } : {}),
		};
	}
}
