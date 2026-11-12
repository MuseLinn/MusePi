import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult } from "@musepi/pi-agent-core";
import { prompt } from "@musepi/pi-utils";
import notifyUserDescription from "../prompts/tools/notify-user.md" with { type: "text" };
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { toolResult } from "./tool-result";

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
