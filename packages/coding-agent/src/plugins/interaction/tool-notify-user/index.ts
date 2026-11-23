/**
 * The `notify_user` tool as a capability package.
 *
 * The implementation lives here rather than in `src/tools/` for the same reason
 * the reference harness keeps it inside `tool-*`: a tool that ships as a package
 * carries its own definition, so the package is the unit of distribution,
 * review and replacement. `src/tools/` keeps only the shared layers every tool
 * depends on (contract, result helpers, render utilities, approval, ownership).
 */
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { prompt } from "@musepi/pi-utils";
import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import notifyUserDescription from "../../../prompts/tools/notify-user.md" with { type: "text" };
import type { ToolSession } from "../../../tools/contract";
import type { OutputMeta } from "../../../tools/output-meta";
import { registerToolProvider } from "../../../tools/tool-ownership";
import { toolResult } from "../../../tools/tool-result";

export const name = "musepi-tool-notify-user";
export const inject = [] as const;
export const provide = [] as const;

const notifyUserSchema = type({
	title: type("string").describe("one-line headline; no markdown, no trailing period"),
	message: type("string").describe("short chat-style update: evidence, findings, next step"),
});

type NotifyUserParams = typeof notifyUserSchema.infer;

export interface NotifyUserDetails {
	title: string;
	message: string;
	meta?: OutputMeta;
}

/**
 * Post a progress update into the conversation without ending the turn.
 *
 * The update IS the tool call: the renderer shows `title` + `message` as a
 * progress card, and the round-fold exemption in round-collapse keeps that
 * row visible after the turn's process folds away. Nothing is persisted
 * separately — the wire entry is both the transcript row and the model's
 * record of what it told the user.
 *
 * Gated by `notifyUser` at session creation, so switching the setting only
 * affects sessions created after it (the tool set is fixed per session).
 */
export class NotifyUserTool implements AgentTool<typeof notifyUserSchema, NotifyUserDetails> {
	readonly name = "notify_user";
	readonly approval = "read" as const;
	readonly label = "Progress update";
	readonly summary = "Post a progress update to the user without ending the turn";
	readonly description: string;
	readonly parameters = notifyUserSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	/** Posting a notice has no side effect beyond the message the transcript
	 *  already persists, so it must not take the pre-execution durable flush:
	 *  a wedged journal write would otherwise block the calls queued behind
	 *  it for a purely visual update. */
	readonly requiresDurableIntent = false;
	readonly intent = (args: Partial<NotifyUserParams>) => args.title ?? "posting a progress update";

	constructor(_session: ToolSession) {
		this.description = prompt.render(notifyUserDescription);
	}

	async execute(_toolCallId: string, params: NotifyUserParams): Promise<AgentToolResult<NotifyUserDetails>> {
		return toolResult<NotifyUserDetails>({ title: params.title, message: params.message })
			.text("Progress update shown to the user. Continue the task; do not restate the update in your final answer.")
			.done();
	}
}

export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "notify"), "tool-notify-user:notify");
	ctx.effect!(
		registerToolProvider("notify_user", session => new NotifyUserTool(session)),
		"tool-notify-user:provide",
	);
}
