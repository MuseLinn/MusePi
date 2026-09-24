/**
 * Canonical inventory of wire tool names that have a first-party card
 * renderer in `registry.ts` (RENDERERS). This is the single source of truth
 * for "which tools render as cards" outside the React module graph:
 *
 * - The extension center's builtin registry (coding-agent) mirrors the list
 *   into its tool-render pack entry (`raw.tools`); a coding-agent contract
 *   test intersects this export against that mirror so a renderer added
 *   here never goes unregistered in the plugin management surface.
 * - `registry.test.ts` guards the other direction: every RENDERERS key must
 *   be listed here.
 *
 * Keep sorted; aliases (wire names mapping to a shared renderer) are real
 * renderable names and belong in the list.
 */
export const TOOL_RENDER_CARD_TOOLS: readonly string[] = [
	"apply_patch",
	"ask",
	"ast_edit",
	"ast_grep",
	"await",
	"bash",
	"board",
	"browser",
	"cancel_job",
	"computer",
	"debug",
	"edit",
	"eval",
	"fetch",
	"find",
	"generate_image",
	"github",
	"glob",
	"goal",
	"grep",
	"hub",
	"inspect_image",
	"irc",
	"job",
	"js",
	"lsp",
	"notebook",
	"poll",
	"propose",
	"puppeteer",
	"python",
	"read",
	"recall",
	"reflect",
	"reject",
	"report_tool_issue",
	"resolve",
	"retain",
	"schedule_task",
	"search",
	"task",
	"todo",
	"vibe_kill",
	"vibe_list",
	"vibe_send",
	"vibe_spawn",
	"vibe_wait",
	"web_search",
	"widget",
	"write",
	"yield",
];
