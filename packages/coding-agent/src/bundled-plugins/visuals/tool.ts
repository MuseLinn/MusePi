/**
 * `widget` tool — draw one self-contained HTML page inline in the reply.
 *
 * The agent-facing card types are gone: data and structure belong in a reply's
 * ```` ```ui ```` block (`packages/client-core/src/ui-blocks`), which is readable,
 * answerable and streams with the reply. A page is what is left here — the one
 * surface that renders a finished layout exactly as it will look.
 *
 * Owned by the `musepi-visuals` built-in plugin, which is the session's visual
 * surface and nothing else. Board card types moved to `bundled-plugins/board`:
 * a board is a separate plugin that depends on this one.
 */
import { type } from "@musepi/musepi-type";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@musepi/pi-agent-core";
import type { ToolExample } from "@musepi/pi-ai";
import { MAX_WIDGET_HTML } from "@musepi/pi-utils";
import widgetDescription from "./prompt.md" with { type: "text" };
import { WIDGET_RENDER_WHEN } from "./when";

// The widget registry lives in guest-client (shared with the GUI board);
// the daemon keeps the type/field table in sync here for schema-driven
// validation and model-facing descriptions.
// WIDGET_TYPES: the board's card schema (also served over the widget.schema
// daemon RPC for the board palette). `data.task` (optional) attaches a runnable
// task to a card — it MUST describe the card's own content (e.g. a ticker
// card's task refreshes rates); unrelated jobs are not allowed on display
// cards.
// Upper bound for widget data (agents sometimes pass verbose payloads);
// oversized data is rejected instead of bloating the transcript.
const MAX_DATA_JSON = 12_000;
/**
 * A rendered page's HTML travels in the tool call's input, which the daemon
 * stores with the message and streams to every client. Shared with the
 * renderer so the two cannot drift: a page over it renders as an "oversize"
 * notice instead of a face, so accepting more here would only defer the
 * failure to the client. Everything else a page needs — the null-origin
 * sandbox, `musepiSubmit` answer handback, theme injection, `.musepi-options`
 * styling, height reporting — is the existing `html` widget's, which is why
 * A page reuses the `html` widget's face rather than adding a second one.
 */
const MAX_PAGE_HTML = MAX_WIDGET_HTML;
/** A page's title is a heading, not a sentence. */
const MAX_PAGE_TITLE = 120;

/**
 * The "when to render" rule is owned by `when.ts`: the system prompt and
 * this tool description must say the same thing, or the model only sees the
 * copy it happens to read. Stated only in the tool description it went
 * unread — asked for a breakdown of lines of code per package, an agent
 * answered with a list and drew the chart only when asked. The prompt.md
 * marker is expanded here so there is no second copy of the wording.
 */
const toolDescription = widgetDescription.replace(/<!-- WIDGET_RENDER_WHEN[^>]*-->/, WIDGET_RENDER_WHEN);

/**
 * Local image paths a page names, in order, at most 12.
 *
 * A sandboxed page cannot read the filesystem, so the chat swaps each path for
 * the file's contents before drawing it. Matches both a quoted src/CSS value
 * (which may contain spaces — macOS screenshots do) and an unquoted url(...).
 */
const LOCAL_IMAGE_RE =
	/(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;
export const RENDER_PAGE_MAX_LOCAL_IMAGES = 12;

export function renderPageImageSources(html: string): string[] {
	const sources = new Set<string>();
	for (const match of html.matchAll(LOCAL_IMAGE_RE)) {
		sources.add(match[2] ?? match[3] ?? "");
		if (sources.size === RENDER_PAGE_MAX_LOCAL_IMAGES) break;
	}
	return [...sources];
}

const widgetSchema = type({
	"title?": type("string").describe("Page title (a heading, not a sentence)"),
	"html?": type("string").describe(
		'The page\'s HTML: a complete document with inline CSS. Ready classes in the app\'s look: .musepi-box, .musepi-muted, .musepi-table (around a <table>; scrolls sideways), .musepi-num, .musepi-badge[data-tone="success|warning|danger|info"], .musepi-dot, .musepi-bar (style="--value:62%;--color:var(--chart-2)"), .musepi-steps (an <ol>), .musepi-form/.musepi-field/.musepi-input/.musepi-switch/.musepi-segmented, .musepi-options/.musepi-option/.musepi-button (data-variant="outline"|"danger"). Theme vars: --bg, --bg-raised, --fg, --fg-muted, --border, --accent, --accent-fg, --color-success/warning/danger/info, --chart-1..5, --radius-*, --font-sans/mono. Size text in rem/em; never 100vh or height:100% on html/body; give a wide table .musepi-table and charts a fixed pixel height',
	),
	"awaitAnswer?": type("boolean").describe(
		'Set when the page asks the user to choose something: the chat keeps a "waiting for your choice" line under the page until they answer',
	),
});

export interface WidgetToolDetails {
	/** Always `page`: this tool draws one HTML document. The structured card
	 *  types belong to the board, where a card persists on a canvas. */
	action: "page";
	type: string;
	data: Record<string, unknown>;
	title?: string;
	/** The page's HTML. */
	html?: string;
	/** Local image paths the page names; the chat swaps them for file contents
	 *  (a sandboxed page cannot read the filesystem itself). */
	images?: string[];
	/** The page asks the user to choose; the card keeps a waiting line until
	 *  an answer leaves it. */
	awaitAnswer?: boolean;
}

export class WidgetTool implements AgentTool<typeof widgetSchema, WidgetToolDetails> {
	readonly name = "widget";
	readonly label = "Widget";
	readonly strict = true;
	readonly approval = "read" as const;
	/** A presentation tool belongs in the top-level schema; extension tools
	 *  otherwise default to discoverable. */
	readonly loadMode = "essential" as const;
	/** Session gate: the presentation switch must keep working now that the
	 *  tool ships as a builtin plugin — extension tools are otherwise always
	 *  in the slate. */
	readonly enabled = ({ settings }: { settings: { get(key: string): unknown } }): boolean =>
		settings.get("widget.enabled") !== false;
	readonly description = toolDescription;
	readonly parameters = widgetSchema;
	readonly examples: readonly ToolExample<typeof widgetSchema.infer>[] = [
		{
			caption: "Render a comparison page with a choice",
			call: {
				title: "Compare two plans",
				html: "<!doctype html><html><body><h1>Compare two plans</h1><button onclick=\"window.musepiSubmit('Plan A',{plan:'a'})\">Pick A</button></body></html>",
			},
		},
	];

	async execute(
		_toolCallId: string,
		params: typeof widgetSchema.infer,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<WidgetToolDetails>,
		_context?: unknown,
	): Promise<AgentToolResult<WidgetToolDetails>> {
		const html = typeof params.html === "string" ? params.html : "";
		if (!html.trim()) {
			return {
				content: [{ type: "text", text: "widget (page): html is required and must not be empty" }],
				isError: true,
			};
		}
		if (html.length > MAX_PAGE_HTML) {
			return {
				content: [
					{
						type: "text",
						text: `widget (page): html exceeds ${MAX_PAGE_HTML} characters — trim styles, comments and inline scripts`,
					},
				],
				isError: true,
			};
		}
		const title = typeof params.title === "string" ? params.title.trim() : "";
		if (title.length > MAX_PAGE_TITLE) {
			return {
				content: [{ type: "text", text: `widget (page): title exceeds ${MAX_PAGE_TITLE} characters` }],
				isError: true,
			};
		}
		const details: WidgetToolDetails = {
			action: "page",
			// A page IS the `html` widget's face: same sandbox, same
			// `musepiSubmit` handback, same theme tokens. Reusing the type keeps
			// one implementation instead of two.
			type: "html",
			data: { html },
			html,
			images: renderPageImageSources(html),
			...(params.awaitAnswer === true ? { awaitAnswer: true } : {}),
		};
		if (title) details.title = title;
		return {
			content: [
				{
					type: "text",
					text:
						`Rendered page${title ? ` "${title}"` : ""} (${html.length} characters). ` +
						"Shown to the user in the chat above your reply. Don't announce, describe or restate the page; reply with only what it doesn't already say." +
						(details.images?.length
							? ` The page references ${details.images.length} local image(s), which the chat inlines for it.`
							: ""),
				},
			],
			details,
		};
	}
}
