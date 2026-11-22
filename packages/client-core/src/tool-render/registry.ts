/**
 * Tool renderer slot registry: one keyed slot per wire tool name. Keys are
 * current wire names; aliases keep old transcript names renderable. Built-in
 * and extension views occupy the same keyed slots, and unknown tools fall back
 * to the generic JSON renderer.
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
import { extensionsRenderer } from "./tools/extensions";
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
import { notifyUserRenderer } from "./tools/notify-user";
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

/**
 * `tool.call.toolview` keyed slot: one renderer per wire tool name. Built-in
 * views and extension-contributed views register through the same functions;
 * a registration occupies the key (single semantics) and its disposer restores
 * the previous occupant. `ToolView` resolves every card through this one table,
 * so extensions never take a second dispatch path.
 */
const toolViewSlots = new Map<string, { renderer: ToolRenderer; owner: number }>();

/** Per-key registration stack: the top entry occupies the slot, the entries
 *  below are the views it replaced. Releases remove their own entry, so an
 *  out-of-order release never resurrects a stale view above a newer one. */
const toolViewStacks = new Map<string, Array<{ renderer: ToolRenderer; owner: number }>>();
let slotOwnerSeq = 0;

/** Built-in views, one module per action family. They register exactly like
 *  extension views — the import list above is the built-in contribution set. */
const BUILTIN_TOOL_VIEWS: Readonly<Record<string, ToolRenderer>> = {
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
	ext_define: extensionsRenderer,
	ext_inspect: extensionsRenderer,
	ext_run: extensionsRenderer,
	ext_stop: extensionsRenderer,
	ext_undefine: extensionsRenderer,
	extension_load: extensionsRenderer,
	extension_reload: extensionsRenderer,
	extension_rollback: extensionsRenderer,
	extension_status: extensionsRenderer,
	extension_validate: extensionsRenderer,
	extensions_list: extensionsRenderer,
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
	notify_user: notifyUserRenderer,
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

for (const [key, renderer] of Object.entries(BUILTIN_TOOL_VIEWS)) {
	toolViewSlots.set(key, { renderer, owner: 0 });
}

function settleSlot(key: string): void {
	const stack = toolViewStacks.get(key);
	const top = stack?.[stack.length - 1];
	if (top !== undefined) {
		toolViewSlots.set(key, top);
		return;
	}
	const builtin = BUILTIN_TOOL_VIEWS[key];
	if (builtin !== undefined) toolViewSlots.set(key, { renderer: builtin, owner: 0 });
	else toolViewSlots.delete(key);
}

/**
 * Occupy one tool's view slot. The returned disposer removes this registration
 * and settles the slot on the newest surviving registration (or the built-in
 * view), so a reloaded extension set never leaves a stale card behind.
 */
export function registerToolViewSlot(key: string, renderer: ToolRenderer): () => void {
	const entry = { renderer, owner: ++slotOwnerSeq };
	const stack = toolViewStacks.get(key) ?? [];
	stack.push(entry);
	toolViewStacks.set(key, stack);
	settleSlot(key);
	return () => {
		const current = toolViewStacks.get(key);
		if (current === undefined) return;
		const index = current.indexOf(entry);
		if (index < 0) return;
		current.splice(index, 1);
		settleSlot(key);
	};
}

export function resolveToolRenderer(name: string): ToolRenderer {
	return toolViewSlots.get(name)?.renderer ?? genericRenderer;
}

/**
 * Card head title: the tool's action name ("运行命令", "加载扩展"). The card's
 * status chrome (spinner / dot) carries running-vs-finished, so the title never
 * prefixes a repeated "正在使用 / Using" verb; the argument summary beside it is
 * the variable part the user actually reads. An explicit `label` (the extension
 * override) wins over the renderer's own `labelKey`, which wins over the
 * wire-name entry in {@link TOOL_RENDER_CARD_LABELS} — the last one is what
 * keeps shared renderers (browser/puppeteer, eval/js/python/notebook, …) titled
 * by the wire tool that was actually called. Renderers with none of these
 * (unknown wire names, extension views that declare no label) keep the raw wire
 * name — the pre-title behavior — so an unrecognized tool never gets a
 * misleading localized identity.
 */
export function toolCallTitle(name: string, renderer: ToolRenderer): string {
	const explicit = renderer.label;
	const labelKey = renderer.labelKey ?? TOOL_RENDER_CARD_LABELS[name];
	let label: string | null = null;
	if (explicit !== undefined && explicit.length > 0) label = explicit;
	else if (labelKey !== undefined) label = tLoose(labelKey);
	if (label === null || label.length === 0) return name;
	return label;
}

/** Wire tool names with a builtin card renderer (the built-in contribution
 *  set). The canonical sorted inventory lives in `card-tools.ts`; the registry
 *  test guards the two against drift. */
export function builtinRendererToolNames(): string[] {
	return Object.keys(BUILTIN_TOOL_VIEWS);
}

/** One restore per currently registered extension view. */
const extensionSlotRestores = new Map<string, () => void>();

/** Replace the extension-contributed view set (GUI extensions.list
 *  `toolViews`, compiled modules blob-imported at runtime). Each key occupies
 *  the same slot a built-in view uses; clearing restores the built-in view. */
export function registerExternalToolRenderers(renderers: Record<string, ToolRenderer>): void {
	for (const restore of extensionSlotRestores.values()) restore();
	extensionSlotRestores.clear();
	for (const [key, renderer] of Object.entries(renderers)) {
		extensionSlotRestores.set(key, registerToolViewSlot(key, renderer));
	}
}
