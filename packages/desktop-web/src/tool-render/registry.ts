/**
 * Tool renderer registry. Keys are current wire tool names; aliases keep old
 * transcript names renderable. Unknown tools fall back to the generic JSON renderer.
 */
import { genericRenderer } from "./generic";
import { askRenderer } from "./tools/ask";
import { astEditRenderer } from "./tools/ast-edit";
import { astGrepRenderer } from "./tools/ast-grep";
import { bashRenderer } from "./tools/bash";
import { boardRenderer } from "./tools/board";
import { browserRenderer } from "./tools/browser";
import { computerRenderer } from "./tools/computer";
import { debugRenderer } from "./tools/debug";
import { editRenderer } from "./tools/edit";
import { evalRenderer } from "./tools/eval";
import { fetchRenderer } from "./tools/fetch";
import { generateImageRenderer } from "./tools/generate-image";
import { githubRenderer } from "./tools/github";
import { globRenderer } from "./tools/glob";
import { goalRenderer } from "./tools/goal";
import { grepRenderer } from "./tools/grep";
import { hubRenderer } from "./tools/hub";
import { inspectImageRenderer } from "./tools/inspect-image";
import { ircRenderer } from "./tools/irc";
import { jobRenderer } from "./tools/job";
import { lspRenderer } from "./tools/lsp";
import { recallRenderer } from "./tools/memory-recall";
import { reflectRenderer } from "./tools/memory-reflect";
import { retainRenderer } from "./tools/memory-retain";
import { readRenderer } from "./tools/read";
import { reportToolIssueRenderer } from "./tools/report-tool-issue";
import { resolveRenderer } from "./tools/resolve";
import { taskRenderer } from "./tools/task";
import { todoRenderer } from "./tools/todo";
import { vibeRenderer } from "./tools/vibe";
import { webSearchRenderer } from "./tools/web-search";
import { widgetRenderer } from "./tools/widget";
import { writeRenderer } from "./tools/write";
import { yieldRenderer } from "./tools/yield";
import type { ToolRenderer } from "./types";

const RENDERERS: Record<string, ToolRenderer> = {
	ask: askRenderer,
	ast_edit: astEditRenderer,
	ast_grep: astGrepRenderer,
	bash: bashRenderer,
	board: boardRenderer,
	browser: browserRenderer,
	puppeteer: browserRenderer,
	computer: computerRenderer,
	debug: debugRenderer,
	edit: editRenderer,
	apply_patch: editRenderer,
	eval: evalRenderer,
	js: evalRenderer,
	python: evalRenderer,
	notebook: evalRenderer,
	fetch: fetchRenderer,
	glob: globRenderer,
	find: globRenderer,
	generate_image: generateImageRenderer,
	github: githubRenderer,
	goal: goalRenderer,
	inspect_image: inspectImageRenderer,
	hub: hubRenderer,
	irc: ircRenderer,
	job: jobRenderer,
	await: jobRenderer,
	poll: jobRenderer,
	cancel_job: jobRenderer,
	lsp: lspRenderer,
	recall: recallRenderer,
	reflect: reflectRenderer,
	retain: retainRenderer,
	read: readRenderer,
	report_tool_issue: reportToolIssueRenderer,
	resolve: resolveRenderer,
	reject: resolveRenderer,
	propose: resolveRenderer,
	grep: grepRenderer,
	search: grepRenderer,
	task: taskRenderer,
	todo: todoRenderer,
	vibe_spawn: vibeRenderer,
	vibe_send: vibeRenderer,
	vibe_wait: vibeRenderer,
	vibe_kill: vibeRenderer,
	vibe_list: vibeRenderer,
	web_search: webSearchRenderer,
	write: writeRenderer,
	widget: widgetRenderer,
	yield: yieldRenderer,
};

export function resolveToolRenderer(name: string): ToolRenderer {
	return externalRenderers[name] ?? RENDERERS[name] ?? genericRenderer;
}

/** Extension-contributed per-tool renderers (registerToolView): keyed by
 *  wire tool name, consulted
 *  BEFORE the built-in registry so an extension renderer replaces the
 *  built-in one for that tool. Registered by the GUI from extensions.list
 *  `toolViews` (compiled modules blob-imported at runtime). */
const externalRenderers: Record<string, ToolRenderer> = {};

/** Replace the extension-contributed renderer map (called by the GUI when
 *  extensions.list toolViews change). Pass an empty map to clear. */
export function registerExternalToolRenderers(renderers: Record<string, ToolRenderer>): void {
	for (const key of Object.keys(externalRenderers)) delete externalRenderers[key];
	Object.assign(externalRenderers, renderers);
}
