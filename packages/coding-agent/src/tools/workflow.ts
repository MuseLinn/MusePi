import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import workflowDescription from "../prompts/tools/workflow.md" with { type: "text" };
import type { ToolSession } from "./contract";
import { EvalTool } from "./eval";

export const workflowSchema = type({
	name: type("string").describe("Short kebab-case workflow name used in the result envelope."),
	description: type("string").describe("One-line description of what the workflow does.").optional(),
	script: type("string").describe(
		"Plain JavaScript body, not TypeScript, without an `export const meta` statement. Top-level await and return are allowed. Globals: `args` (the args object), `agent(prompt, options)` for subagents, `parallel(thunks)`, `pipeline(items, ...stages)`, `log(message)`, `phase(title)`, `budget`, and `tool.<name>(args)`.",
	),
	args: type("object").describe("Optional JSON object exposed to the script as the `args` global.").optional(),
	run_in_background: type("boolean")
		.describe("Run as an async job and return immediately; the result arrives as a follow-up turn.")
		.optional(),
});

export interface WorkflowToolDetails {
	name: string;
	description?: string;
	background?: boolean;
	jobId?: string;
}

const DEFAULT_MAX_RESULT_CHARS = 50_000;

/**
 * Run a JavaScript orchestration script that fans work out across subagents
 * Execution reuses the session's JS eval kernel, so the
 * script has the same `agent()` / `parallel()` / `pipeline()` surface as
 * `eval`; a foreground call waits for the run, while `run_in_background`
 * registers it with the session's async job manager and returns its id.
 */
export class WorkflowTool implements AgentTool<typeof workflowSchema, WorkflowToolDetails> {
	readonly name = "workflow";
	readonly approval = "exec" as const;
	readonly label = "Workflow";
	readonly summary = "Run a JavaScript orchestration across subagents";
	readonly description = workflowDescription.trim();
	readonly parameters = workflowSchema;
	readonly loadMode = "essential";

	constructor(
		private readonly session: ToolSession,
		private readonly maxResultChars = DEFAULT_MAX_RESULT_CHARS,
	) {}

	#code(params: typeof workflowSchema.infer): string {
		return `globalThis.args = ${JSON.stringify(params.args ?? {})};\n${params.script}`;
	}

	async #run(
		toolCallId: string,
		params: typeof workflowSchema.infer,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback | undefined,
		ctx: AgentToolContext | undefined,
	): Promise<{ text: string; isError: boolean }> {
		const result = await new EvalTool(this.session).execute(
			toolCallId,
			{ language: "js", code: this.#code(params), title: params.name },
			signal,
			onUpdate,
			ctx,
		);
		const text = result.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n");
		return { text, isError: result.isError === true };
	}

	#limited(text: string): string {
		return text.length > this.maxResultChars
			? `${text.slice(0, this.maxResultChars)}\n… (workflow result truncated at ${this.maxResultChars} characters)`
			: text;
	}

	async execute(
		toolCallId: string,
		params: typeof workflowSchema.infer,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		ctx?: AgentToolContext,
	): Promise<AgentToolResult<WorkflowToolDetails>> {
		const script = typeof params.script === "string" ? params.script : "";
		if (script.trim() === "") throw new Error("workflow: script must not be empty");
		if (params.run_in_background === true) return this.#background(toolCallId, params);
		const result = await this.#run(toolCallId, params, signal, onUpdate, ctx);
		return {
			content: [{ type: "text", text: this.#limited(result.text) }],
			details: {
				name: params.name,
				...(typeof params.description === "string" && params.description.trim() !== ""
					? { description: params.description.trim() }
					: {}),
			},
			...(result.isError ? { isError: true } : {}),
		};
	}

	/**
	 * Register the workflow as an async job and return its id. The job records
	 * `kind: "workflow"` on a `task` job row, the same shape a background
	 * question uses, so every existing job surface keeps working; its result
	 * travels the async-result delivery channel as a follow-up turn.
	 */
	#background(toolCallId: string, params: typeof workflowSchema.infer): AgentToolResult<WorkflowToolDetails> {
		const manager = this.session.asyncJobManager;
		if (!manager) throw new Error("workflow: background runs are unavailable in this session.");
		const description =
			typeof params.description === "string" && params.description.trim() !== ""
				? params.description.trim()
				: undefined;
		const jobId = manager.register(
			"task",
			`workflow ${params.name}`,
			async ({ signal, appendOutput }) => {
				appendOutput(`Workflow ${params.name}${description === undefined ? "" : `: ${description}`}\n`);
				const result = await this.#run(toolCallId, params, signal, undefined, undefined);
				if (result.isError) throw new Error(result.text);
				return this.#limited(result.text);
			},
			{
				ownerId: this.session.getAgentId?.() ?? undefined,
				kind: "workflow",
				toolCallId,
			},
		);
		return {
			content: [
				{
					type: "text",
					text: `Started workflow ${params.name} as background job ${jobId}. Continue with other work; the result arrives automatically in a later turn. Do not poll for it or guess it.`,
				},
			],
			details: { name: params.name, ...(description === undefined ? {} : { description }), background: true, jobId },
		};
	}
}
