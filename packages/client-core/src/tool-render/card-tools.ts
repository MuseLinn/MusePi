import type { ToolsKey } from "../i18n/zh-CN/tools.js";

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
	"agnes_video_gen",
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
	"knowledge",
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
	"select_tools",
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

/**
 * Localized card title for every wire name the GUI renders. `registry.ts`
 * resolves the key for the name it dispatches, so a shared renderer still
 * reports the name of the wire tool that was actually called (a `puppeteer`
 * call reads "浏览器自动化", not `browser`'s title). Aliases that mean the same
 * thing share a translation key.
 *
 * Built-in tools with no dedicated card renderer (checkpoint, security_scan, …)
 * are listed too: their generic body keeps the args digest, but the head still
 * gets a readable title. A name absent here keeps the pre-title raw wire name.
 */
export const TOOL_RENDER_CARD_LABELS: Readonly<Record<string, ToolsKey>> = {
	apply_patch: "tools.toolApplyPatch",
	ask: "tools.toolAsk",
	ast_edit: "tools.toolAstEdit",
	ast_grep: "tools.toolAstGrep",
	agnes_video_gen: "tools.toolAgnesVideoGen",
	await: "tools.toolAwait",
	bash: "tools.toolBash",
	board: "tools.toolBoard",
	browser: "tools.toolBrowser",
	cancel_job: "tools.toolCancelJob",
	checkpoint: "tools.toolCheckpoint",
	computer: "tools.toolComputer",
	debug: "tools.toolDebug",
	edit: "tools.toolEdit",
	eval: "tools.toolEval",
	fetch: "tools.toolFetch",
	find: "tools.toolFind",
	generate_image: "tools.toolGenerateImage",
	github: "tools.toolGithub",
	glob: "tools.toolGlob",
	goal: "tools.toolGoal",
	grep: "tools.toolGrep",
	hub: "tools.toolHub",
	inspect_image: "tools.toolInspectImage",
	irc: "tools.toolIrc",
	job: "tools.toolJob",
	js: "tools.toolJs",
	knowledge: "tools.toolKnowledge",
	learn: "tools.toolLearn",
	lsp: "tools.toolLsp",
	manage_skill: "tools.toolManageSkill",
	memory_edit: "tools.toolMemoryEdit",
	notebook: "tools.toolNotebook",
	poll: "tools.toolPoll",
	propose: "tools.toolPropose",
	puppeteer: "tools.toolPuppeteer",
	python: "tools.toolPython",
	read: "tools.toolRead",
	recall: "tools.toolRecall",
	reflect: "tools.toolReflect",
	reject: "tools.toolReject",
	report_tool_issue: "tools.toolReportToolIssue",
	resolve: "tools.toolResolve",
	retain: "tools.toolRetain",
	rewind: "tools.toolRewind",
	schedule_task: "tools.toolScheduleTask",
	security_scan: "tools.toolSecurityScan",
	search: "tools.toolSearch",
	select_tools: "tools.toolSelectTools",
	task: "tools.toolTask",
	todo: "tools.toolTodo",
	vibe_kill: "tools.toolVibeKill",
	vibe_list: "tools.toolVibeList",
	vibe_send: "tools.toolVibeSend",
	vibe_spawn: "tools.toolVibeSpawn",
	vibe_wait: "tools.toolVibeWait",
	web_search: "tools.toolWebSearch",
	widget: "tools.toolWidget",
	write: "tools.toolWrite",
	yield: "tools.toolYield",
};
