/**
 * Delegation guidance owned by the `delegation` bundled plugin.
 *
 * This is one tool section for `task`: the eager/codex policy, the gates and
 * the concurrency variants are rendered together so a rebuild can never stack
 * two delegation blocks. The host supplies the active task wire name. The
 * static prose and its dynamic branches live in `delegation.md` (Handlebars);
 * this function only collects the template data and renders.
 */
import { prompt } from "@musepi/pi-utils";
import type { PromptHostSurface } from "../../prompts/host";
import { PROMPT_ORDERS } from "../../prompts/orders";
import type { PromptContributionContext } from "../../prompts/types";
import { wireName } from "../prompt-context";
import delegationTemplate from "./delegation.md" with { type: "text" };

export const DELEGATION_PROMPT_OWNER = "bundled:delegation";

export function renderDelegation(context: PromptContributionContext): string {
	const eager = context.eagerTasks === true;
	const codex = context.useCodexTaskPrompt === true;
	return prompt.render(delegationTemplate, {
		task: wireName(context, "task"),
		codexProactive: codex && eager,
		codexRestricted: codex && !eager,
		eagerDefault: !codex && eager && context.eagerTasksAlways === true,
		eagerPreferred: !codex && eager && context.eagerTasksAlways !== true,
		taskBatch: context.taskBatch === true,
		scoutAvailable: context.scoutAvailable === true,
		taskIrcEnabled: context.taskIrcEnabled === true,
		maxConcurrency: typeof context.MAX_CONCURRENCY === "number" ? context.MAX_CONCURRENCY : 0,
	});
}

export function registerDelegationPrompts(host: PromptHostSurface): () => void {
	host.removeByOwner(DELEGATION_PROMPT_OWNER);
	return host.registerTool({
		tool: "task",
		order: PROMPT_ORDERS.tool,
		text: renderDelegation,
		owner: DELEGATION_PROMPT_OWNER,
	});
}
