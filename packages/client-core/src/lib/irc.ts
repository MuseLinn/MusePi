/**
 * Inter-agent IRC message shape, shared by the GUI transcript and the
 * session-Markdown export.
 *
 * `details` is the display contract. Relay and autoreply `content` carry a
 * bracketed `[IRC a → b]` route prepended for the transcript snapshot, and an
 * incoming `content` is the rendered `irc-incoming.md` prompt template; the
 * presentation composes the route from `details` and never echoes either
 * header. Kept free of React and i18n so the export can use it without pulling
 * the component tree into a non-DOM process.
 */

import { contentText } from "./content-text";

export type IrcKind = "incoming" | "autoreply" | "relay";

export interface IrcPresentation {
	kind: IrcKind;
	/** Undefined means this session (the reader's side). */
	from?: string;
	/** Undefined means this session (the reader's side). */
	to?: string;
	body: string;
	replyTo?: string;
}

const ROUTE_HEADER = /^\s*\[IRC[^\]\n]*]\s*\n*/;
const INCOMING_ATTRIBUTION = /^\s*Incoming IRC message from agent[^\n]*\n+/i;
const INCOMING_INSTRUCTIONS = /\n+(?:If response expected|Mid-task:|Sent while waiting\/working)[\s\S]*$/i;

function stripScaffolding(text: string): string {
	return text
		.replace(ROUTE_HEADER, "")
		.replace(/^\s*<irc>\s*/i, "")
		.replace(/\s*<\/irc>\s*$/i, "")
		.replace(INCOMING_ATTRIBUTION, "")
		.replace(INCOMING_INSTRUCTIONS, "")
		.trim();
}

function strField(details: unknown, key: string): string | undefined {
	if (details === null || typeof details !== "object" || !(key in details)) return undefined;
	const value = (details as Record<string, unknown>)[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function ircKind(customType: string): IrcKind {
	if (customType === "irc:incoming") return "incoming";
	if (customType === "irc:autoreply") return "autoreply";
	return "relay";
}

/**
 * Display shape of one `irc:*` custom message. Undefined `from`/`to` mean the
 * reader's own session (an incoming DM has no `to`; an autoreply has no
 * `from`), so each renderer names that side itself instead of inventing a
 * sender.
 */
export function ircPresentation(customType: string, content: unknown, details: unknown): IrcPresentation {
	const kind = ircKind(customType);
	const body =
		kind === "incoming"
			? (strField(details, "message") ?? stripScaffolding(contentText(content)))
			: (strField(details, "body") ?? stripScaffolding(contentText(content)));
	return {
		kind,
		from: kind === "autoreply" ? undefined : strField(details, "from"),
		to: kind === "incoming" ? undefined : strField(details, "to"),
		body,
		replyTo: strField(details, "replyTo"),
	};
}
