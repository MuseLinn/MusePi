/**
 * What a running tool is doing, in the status line's words.
 *
 * Neutral by design: this is the shared vocabulary the transcript's tail
 * presence reads, not any one renderer's state enum. The desktop companion
 * maps it onto its own verbs and the thinking-orb maps it onto its own
 * states — neither enum is imported here, and this one is never fed back
 * into the other (see `apps/desktop/src/lib/agent-signals.ts`).
 *
 * Two sources, in order:
 *   1. a structured kind the caller already holds (the transcript's
 *      `ToolKind`, or an ACP agent's own `kind`) — the engine's own
 *      declaration beats any guess from a name;
 *   2. the tool's wire name, matched against the families below.
 *
 * The name table follows OpenMausBot's `server/drivers/tool-progress.ts`
 * (`CLAUDE_TOOLS` / `ACP_KINDS`), widened with MusePi's own built-ins.
 */
export type ToolActivityKind =
	| "thinking"
	| "searching"
	| "reading"
	| "writing"
	| "running-commands"
	| "browsing"
	| "using-computer"
	| "messaging"
	| "waiting"
	| "working";

/** A structured kind a caller may already know: MusePi's `ToolKind`, or an
 *  ACP tool call's own `kind`. Anything else is ignored. */
export type StructuredToolKind = "diff" | "search" | "image" | "edit" | "delete" | "move" | "execute" | "read" | "fetch" | "other";

const STRUCTURED: Record<string, ToolActivityKind> = {
	diff: "writing",
	edit: "writing",
	delete: "writing",
	move: "writing",
	search: "searching",
	read: "reading",
	execute: "running-commands",
	fetch: "browsing",
	image: "working",
	other: "working",
};

/**
 * Ordered families: the first match wins, so the narrower patterns come
 * before the wider ones (an `astgrep` is a search, not a read; a
 * `websearch` is a search, not browsing). Patterns match the collapsed
 * spelling (`webfetch`, `astgrep`), so one entry covers `web_fetch`,
 * `WebFetch` and `web-fetch`.
 */
const FAMILIES: ReadonlyArray<readonly [RegExp, ToolActivityKind]> = [
	// searching — content and file lookup
	[/^(?:grep|glob|ls|find|astgrep|ripgrep|rg|websearch|search)$/, "searching"],
	[/^(?:recall|knowledge|listsecrets|listbots|listagents)$/, "searching"],
	// reading
	[/^(?:read|view|cat|inspect|inspectimage|openfile)$/, "reading"],
	// writing
	[/^(?:write|edit|multiedit|notebookedit|applypatch|patch|astedit|strreplace|replace|memoryedit)$/, "writing"],
	// running-commands
	[/^(?:bash|shell|exec|command|run|runcommand|terminal|eval|bashinteractive)$/, "running-commands"],
	// browsing
	[/^(?:browser|fetch|fetchurl|webfetch|http|navigate|openurl|readpage)$/, "browsing"],
	// using-computer
	[/^(?:computer|screenshot|screencapture|mouse|keyboard|click|type|keypress|press|scroll)$/, "using-computer"],
	// messaging
	[/^(?:message|messageperson|sendmessage|chat|reply|notifyuser|posttoroom|posttogroup|messagebot|askbot)$/, "messaging"],
	// waiting on the person
	[/^(?:ask|askuser|askuserquestion|approval|requestsecret|requestapproval|todo)$/, "waiting"],
];

const MCP_PREFIX = /^mcp__[^_]+(?:_[^_]+)*?__/;

/** Strip a `mcp__<server>__` prefix so a connector's tool classifies by its
 *  own name (`mcp__files__read` reads). */
function bareName(toolName: string): string {
	return toolName.replace(MCP_PREFIX, "");
}

/**
 * Compare in one spelling: `WebFetch` and `web_fetch` are the same family, so
 * both spellings collapse to `webfetch` before matching.
 */
function normalized(toolName: string): string {
	return bareName(toolName).trim().toLowerCase().replace(/[_\-\s]+/g, "");
}

/**
 * Classify a tool call. `kind` is a structured kind the caller already has
 * (the transcript's `ToolKind`, an ACP call's `kind`); when present it wins
 * over the name. Unknown, empty and missing names classify as `working` —
 * the tail presence then says "正在处理" rather than guessing.
 */
export function toolActivityKind(
	toolName: string | null | undefined,
	kind?: StructuredToolKind | string | null,
): ToolActivityKind {
	if (typeof kind === "string" && kind in STRUCTURED) return STRUCTURED[kind]!;
	const name = normalized(toolName ?? "");
	if (!name) return "working";
	for (const [pattern, activity] of FAMILIES) {
		if (pattern.test(name)) return activity;
	}
	return "working";
}
