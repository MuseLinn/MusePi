/**
 * Project context sections on the session PromptHost.
 *
 * OWNERSHIP: AGENTS.md context files (`<repo-rules>` / `<dir-context>`), the
 * workspace tree and the active-repo context used to render inline inside the
 * base `buildSystemPrompt` project block. They now live here as
 * `cacheScope: "snapshot"` sections under ONE owner, and the session's base
 * call stops passing them, so exactly one owner ever writes this content.
 *
 * REUSE: discovery stays with the session (`discoverContextFiles`,
 * `resolveActiveRepoContext`, the workspace-tree promise); rendering reuses the
 * very templates the base path used, extracted verbatim into
 * `project-context.md`; dedup is the host store's one-section-per-name plus the
 * function-text re-render, so a state change replaces the section instead of
 * stacking a second copy.
 *
 * The custom-prompt layout keeps its context-file rendering in the base
 * template (`baseOwnsContextFiles`), so that layout also has a single owner
 * per piece.
 */
import { prompt } from "@musepi/pi-utils";
import { type BuildSystemPromptOptions, renderActiveRepoContextPrompt } from "../system-prompt";
import type { ActiveRepoContext } from "../utils/active-repo-context";
import { AGENTS_MD_LIMIT, type WorkspaceTree } from "../workspace-tree";
import type { PromptHostSurface } from "./host";
import { PROMPT_ORDERS } from "./orders";
import projectContextTemplate from "./system/project-context.md" with { type: "text" };
import type { PromptCacheScope } from "./types";

/** The single owner of every project-context contribution. */
export const PROJECT_CONTEXT_OWNER = "session:project-context";

/** Section names and slots; the active-repo piece keeps the legacy repo slot. */
export const PROJECT_CONTEXT_SECTIONS = {
	agents: { name: "project:context", order: PROMPT_ORDERS.project },
	activeRepo: { name: "project:active-repo", order: PROMPT_ORDERS.repoContext },
} as const;

type ProjectContextFile = NonNullable<BuildSystemPromptOptions["contextFiles"]>[number];

/** Discovered project context, refreshed by the session on every rebuild. */
export interface ProjectContextState {
	contextFiles: readonly ProjectContextFile[];
	workspaceTree: WorkspaceTree;
	includeWorkspaceTree: boolean;
	activeRepoContext: ActiveRepoContext | null;
	/** The custom-prompt base template renders context files itself. */
	baseOwnsContextFiles: boolean;
}

/** Mutable holder the registered function text reads at assembly time. */
export interface ProjectContextHolder {
	current: ProjectContextState;
}

export interface ProjectContextSectionRender {
	name: string;
	order: number;
	cacheScope: PromptCacheScope;
	text: string | undefined;
}

/** Assembly inputs the AGENTS/tree template needs from the live tool set. */
export interface ProjectContextRenderContext {
	activeTools?: readonly string[];
	toolRefs?: Record<string, string>;
}

/** Same cap/sort the base path applied to the discovered AGENTS.md index. */
function agentsMdSearchFiles(workspaceTree: WorkspaceTree): string[] {
	return Array.from(new Set(workspaceTree.agentsMdFiles)).sort().slice(0, AGENTS_MD_LIMIT);
}

/**
 * Render the AGENTS.md + workspace-tree section.
 *
 * Returns undefined when there is nothing to render so the assembly omits the
 * section instead of contributing an empty block.
 */
export function renderAgentsContextSection(
	state: ProjectContextState,
	context: ProjectContextRenderContext = {},
): string | undefined {
	if (state.baseOwnsContextFiles) return undefined;
	const agentsMdFiles = agentsMdSearchFiles(state.workspaceTree);
	const hasTree = state.includeWorkspaceTree && state.workspaceTree.rendered.length > 0;
	if (state.contextFiles.length === 0 && agentsMdFiles.length === 0 && !hasTree) return undefined;
	const rendered = prompt.render(projectContextTemplate, {
		contextFiles: state.contextFiles,
		agentsMdSearch: { files: agentsMdFiles },
		includeWorkspaceTree: state.includeWorkspaceTree,
		workspaceTree: state.workspaceTree,
		tools: [...(context.activeTools ?? [])],
		toolRefs: context.toolRefs ?? {},
	});
	return rendered.trim() || undefined;
}

/** Render the active-repo section; undefined when the cwd is not beside a child repo. */
export function renderActiveRepoContextSection(state: ProjectContextState): string | undefined {
	const rendered = renderActiveRepoContextPrompt(state.activeRepoContext);
	return rendered.length > 0 ? rendered : undefined;
}

/** Render every project-context section for one discovered state. */
export function renderProjectContextSections(
	state: ProjectContextState,
	context: ProjectContextRenderContext = {},
): ProjectContextSectionRender[] {
	return [
		{
			name: PROJECT_CONTEXT_SECTIONS.agents.name,
			order: PROJECT_CONTEXT_SECTIONS.agents.order,
			cacheScope: "snapshot",
			text: renderAgentsContextSection(state, context),
		},
		{
			name: PROJECT_CONTEXT_SECTIONS.activeRepo.name,
			order: PROJECT_CONTEXT_SECTIONS.activeRepo.order,
			cacheScope: "snapshot",
			text: renderActiveRepoContextSection(state),
		},
	];
}

/**
 * Register the project-context sections once. The holder is mutated by the
 * session on every rebuild; the function text re-renders at assembly time, so
 * a discovery change replaces the section instead of accumulating a copy.
 *
 * Both sections are registered with `interpolate: false`: discovered context
 * content is data, not a template, so a `{{ name }}` sequence inside an
 * AGENTS.md passes through literally instead of failing strict variable
 * resolution — no literal-brace variable guard is needed.
 *
 * The session registers once per session and never disposes explicitly; the
 * returned disposer releases both sections (used by tests and by
 * `promptHost.close()` on session teardown).
 */
export function registerProjectContextSections(host: PromptHostSurface, holder: ProjectContextHolder): () => void {
	const disposeSections = [
		host.registerSection({
			name: PROJECT_CONTEXT_SECTIONS.agents.name,
			order: PROJECT_CONTEXT_SECTIONS.agents.order,
			cacheScope: "snapshot",
			interpolate: false,
			owner: PROJECT_CONTEXT_OWNER,
			text: context => renderAgentsContextSection(holder.current, context),
		}),
		host.registerSection({
			name: PROJECT_CONTEXT_SECTIONS.activeRepo.name,
			order: PROJECT_CONTEXT_SECTIONS.activeRepo.order,
			cacheScope: "snapshot",
			interpolate: false,
			owner: PROJECT_CONTEXT_OWNER,
			text: () => renderActiveRepoContextSection(holder.current),
		}),
	];
	return () => {
		for (const dispose of disposeSections) dispose();
	};
}
