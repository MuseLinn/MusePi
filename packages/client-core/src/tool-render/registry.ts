/**
 * Tool renderer registry. Keys are current wire tool names; aliases keep old
 * transcript names renderable. Unknown tools fall back to the generic JSON renderer.
 */
import { tLoose } from "../i18n/index.js";
import { TOOL_RENDER_CARD_LABELS } from "./card-tools";
import { genericRenderer } from "./generic";
import { agnesVideoGenRenderer } from "./tools/agnes-video-gen";
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
import { knowledgeRenderer } from "./tools/knowledge";
import { lspRenderer } from "./tools/lsp";
import { recallRenderer } from "./tools/memory-recall";
import { reflectRenderer } from "./tools/memory-reflect";
import { retainRenderer } from "./tools/memory-retain";
import { readRenderer } from "./tools/read";
import { reportToolIssueRenderer } from "./tools/report-tool-issue";
import { resolveRenderer } from "./tools/resolve";
import { scheduleTaskRenderer } from "./tools/schedule-task";
import { selectToolsRenderer } from "./tools/select-tools";
import { taskRenderer } from "./tools/task";
import { todoRenderer } from "./tools/todo";
import { vibeRenderer } from "./tools/vibe";
import { webSearchRenderer } from "./tools/web-search";
import { widgetRenderer } from "./tools/widget";
import { writeRenderer } from "./tools/write";
import { yieldRenderer } from "./tools/yield";
import type { ToolRenderer } from "./types";

const RENDERERS: Record<string, ToolRenderer> = {
	agnes_video_gen: agnesVideoGenRenderer,
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
	schedule_task: scheduleTaskRenderer,
	resolve: resolveRenderer,
	reject: resolveRenderer,
	propose: resolveRenderer,
	grep: grepRenderer,
	search: grepRenderer,
	select_tools: selectToolsRenderer,
	task: taskRenderer,
	knowledge: knowledgeRenderer,
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

/**
 * Card head title: "已使用 Bash" / "Used Bash" for a labeled renderer, and
 * `running` flips the verb to "正在使用"/"Using". An explicit `label` (the
 * extension override) wins over the renderer's own `labelKey`, which wins over
 * the wire-name entry in {@link TOOL_RENDER_CARD_LABELS} — the last one is what
 * keeps shared renderers (browser/puppeteer, eval/js/python/notebook, …) titled
 * by the wire tool that was actually called. Renderers with none of these
 * (unknown wire names, extension views that declare no label) keep the raw wire
 * name — the pre-title behavior — so an unrecognized tool never gets a
 * misleading localized identity.
 */
export function toolCallTitle(name: string, renderer: ToolRenderer, running = false): string {
	const explicit = renderer.label;
	const labelKey = renderer.labelKey ?? TOOL_RENDER_CARD_LABELS[name];
	let label: string | null = null;
	if (explicit !== undefined && explicit.length > 0) label = explicit;
	else if (labelKey !== undefined) label = tLoose(labelKey);
	if (label === null || label.length === 0) return name;
	return tLoose(running ? "tools.usingTool" : "tools.usedTool", { tool: label });
}

/** Wire tool names with a builtin card renderer (keys of the builtin
 * registry). The canonical sorted inventory lives in `card-tools.ts`; the
 * registry test guards the two against drift. */
export function builtinRendererToolNames(): string[] {
	return Object.keys(RENDERERS);
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
