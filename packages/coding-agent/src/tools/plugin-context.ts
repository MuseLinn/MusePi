/**
 * Helpers shared by bundled plugin prompt sections.
 *
 * The prompt host hands a contribution context with the active tool names and,
 * for `registerTool` contributions, the matched wire name. Ordinary sections
 * (AST covers two tools; host integrations are not tools) resolve the same
 * information from `toolRefs` so the rendered text always names what the model
 * will actually call.
 */
import type { PromptContributionContext } from "../prompts/types";

function refs(context: PromptContributionContext): Record<string, unknown> {
	const value = context.toolRefs;
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

/** Wire name for `tool`, falling back to the canonical internal name. */
export function wireName(context: PromptContributionContext, tool: string): string {
	if (context.tool === tool && typeof context.wireName === "string" && context.wireName.length > 0) {
		return context.wireName;
	}
	const ref = refs(context)[tool];
	return typeof ref === "string" && ref.length > 0 ? ref : tool;
}

/**
 * Wire name of an active tool, or `undefined` when neither the canonical name
 * nor its declared wire name appears in the active set.
 */
export function activeWireName(context: PromptContributionContext, tool: string): string | undefined {
	const wire = wireName(context, tool);
	return context.activeTools.includes(tool) || context.activeTools.includes(wire) ? wire : undefined;
}
