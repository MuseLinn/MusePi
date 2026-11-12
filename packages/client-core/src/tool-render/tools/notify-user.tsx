/**
 * `notify_user` — an agent progress update posted mid-turn.
 *
 * The update is not a tool result to fold away: the card stays open after the
 * turn and is exempt from round folds, so its title/body remain readable. The
 * summary is the title alone; the body is the message exactly as written
 * (pre-wrap, no markdown contract) so a short chat-style update keeps its line
 * breaks.
 */
import type { ReactNode } from "react";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { str } from "../util";

function Summary({ args }: ToolRenderProps): ReactNode {
	const title = str(args.title);
	return <span>{title ?? ""}</span>;
}

function Body({ args }: ToolRenderProps): ReactNode {
	const message = str(args.message);
	if (!message) return null;
	return <p className="tv-progress-update">{message}</p>;
}

export const notifyUserRenderer: ToolRenderer = { Summary, Body };
