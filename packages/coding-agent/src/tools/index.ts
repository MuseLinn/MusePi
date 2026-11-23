import { logger } from "@musepi/pi-utils";
import { EditTool } from "../edit";
import { checkJuliaKernelAvailability } from "../eval/jl/kernel";
import { checkPythonKernelAvailability } from "../eval/py/kernel";
import { checkRubyKernelAvailability } from "../eval/rb/kernel";
import { isCapabilityActive } from "../extensibility/capability-activation";
import { GoalTool } from "../goals/tools/goal-tool";
import { LspTool } from "../lsp";
import { TaskTool } from "../task";
import { canSpawnAtDepth } from "../task/types";
import { isInspectImageToolActive } from "../utils/inspect-image-mode";
import { WebSearchTool } from "../web/search";
import { AskTool } from "./ask";
import { AstEditTool } from "./ast-edit";
import { AstGrepTool } from "./ast-grep";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { type BuiltinToolName, type HiddenToolName, normalizeToolNames } from "./builtin-names";
import { CheckpointTool, RewindTool } from "./checkpoint";
import { ComputerTool } from "./computer";
import { ConnectorCatalogTool } from "./connector-catalog";
import type { Tool, ToolFactory, ToolSession } from "./contract";
import { DebugTool } from "./debug";
import { EvalTool } from "./eval";
import { resolveEvalBackends } from "./eval-backends";
import { isFileBackendToolAllowed } from "./file-backend";
import { GithubTool } from "./gh";
import { GlobTool } from "./glob";
import { GrepTool } from "./grep";
import { HubTool, isIrcEnabled } from "./hub";
import { InspectImageTool } from "./inspect-image";
import { KnowledgeTool } from "./knowledge";
import { LearnTool } from "./learn";
import { ListSecretsTool } from "./list-secrets";
import { ManageSkillTool } from "./manage-skill";
import { MemoryEditTool } from "./memory-edit";
import { MemoryRecallTool } from "./memory-recall";
import { MemoryReflectTool } from "./memory-reflect";
import { MemoryRetainTool } from "./memory-retain";
import { NotifyUserTool } from "./notify-user";
import { OfficeReadTool } from "./office";
import { wrapToolWithMetaNotice } from "./output-meta";
import { PresentTool } from "./present";
import { ReadTool } from "./read";
import { RequestSecretTool } from "./request-secret";
import { SecurityScanTool } from "./security-scan";
import { supportsExternalThinking, ThinkTool } from "./think";
import { TodoTool } from "./todo";
import { isToolOwnerActive, resolveToolImplementation } from "./tool-ownership";
import { WorkflowTool } from "./workflow";
import { WriteTool } from "./write";
import { isMountableUnderXdev } from "./xdev";
import { YieldTool } from "./yield";

export * from "../edit";
export * from "../goals";
export * from "../lsp";
export * from "../session/streaming-output";
export * from "../task";
export * from "../web/search";
export * from "./agnes-video-gen";
export * from "./ask";
export * from "./ast-edit";
export * from "./ast-grep";
export * from "./bash";
export * from "./browser";
export * from "./checkpoint";
export * from "./computer";
export * from "./computer/supervisor";
export * from "./contract";
export * from "./debug";
export * from "./essential-tools";
export * from "./eval";
export * from "./eval-backends";
export * from "./gh";
export * from "./glob";
export * from "./grep";
export * from "./hub";
export * from "./image-gen";
export * from "./inspect-image";
export * from "./learn";
export * from "./list-secrets";
export * from "./manage-skill";
export * from "./memory-edit";
export * from "./memory-recall";
export * from "./memory-reflect";
export * from "./memory-retain";
export * from "./read";
export * from "./report-tool-issue";
export * from "./request-secret";
export * from "./resolve";
export * from "./review";
export * from "./security-scan";
export * from "./think";
export * from "./todo";
export * from "./tool-ownership";
export * from "./tts";
export * from "./vibe";
export * from "./workflow";
export * from "./write";
export * from "./xdev";
export * from "./yield";

/**
 * Public callable factory map. External callers may invoke `BUILTIN_TOOLS.read(session)` or
 * `BUILTIN_TOOLS[name](session)` to construct a tool directly.
 */
export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolFactory> = {
	read: s => new ReadTool(s),
	security_scan: s => new SecurityScanTool(s),
	bash: s => new BashTool(s),
	edit: s => new EditTool(s),
	ast_grep: s => new AstGrepTool(s),
	ast_edit: s => new AstEditTool(s),
	ask: AskTool.createIf,
	debug: DebugTool.createIf,
	eval: s => new EvalTool(s),
	github: GithubTool.createIf,
	glob: s => new GlobTool(s, { rootPathAlias: true }),
	grep: s => new GrepTool(s),
	lsp: LspTool.createIf,
	inspect_image: s => new InspectImageTool(s),
	browser: s => new BrowserTool(s),
	computer: s => new ComputerTool(s),
	checkpoint: CheckpointTool.createIf,
	rewind: RewindTool.createIf,
	task: s => TaskTool.create(s),
	hub: s => new HubTool(s),
	todo: s => new TodoTool(s),
	knowledge: s => new KnowledgeTool(s),
	present: s => new PresentTool(s),
	office_read: s => new OfficeReadTool(s),
	workflow: s => new WorkflowTool(s),
	request_secret: s => new RequestSecretTool(s),
	list_secrets: s => new ListSecretsTool(s),
	// Session-creation gate: the prompt and tool schema are fixed once a
	// session starts, so the toggle only applies to sessions created after it.
	notify_user: s => (s.settings.get("notifyUser") ? new NotifyUserTool(s) : null),
	connector_catalog: () => new ConnectorCatalogTool(),
	web_search: s => new WebSearchTool(s),
	write: s => new WriteTool(s),
	memory_edit: MemoryEditTool.createIf,
	retain: MemoryRetainTool.createIf,
	recall: MemoryRecallTool.createIf,
	reflect: MemoryReflectTool.createIf,
	learn: LearnTool.createIf,
	manage_skill: ManageSkillTool.createIf,
};

export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	think: () => new ThinkTool(),
	yield: s => new YieldTool(s),
	goal: s => new GoalTool(s),
};

export type ToolName = BuiltinToolName;

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const restrictToolNames = session.restrictToolNames === true;
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	const requestedTools = restrictToolNames
		? normalizeToolNames(toolNames ?? [])
		: toolNames && toolNames.length > 0
			? normalizeToolNames(toolNames)
			: undefined;
	const goalEnabled = session.settings.get("goal.enabled");
	const goalModeActive = !restrictToolNames && goalEnabled && session.getGoalModeState?.()?.enabled === true;
	const externalThinkingActive =
		session.settings.get("externalThinking") && supportsExternalThinking(session.getActiveModel?.());
	if (goalModeActive && requestedTools && !requestedTools.includes("goal")) {
		requestedTools.push("goal");
	}
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const allowJs = backends.js;
	const allowRuby = backends.ruby;
	const allowJulia = backends.julia;
	const skipEvalPreflight = session.skipPythonPreflight === true;
	// Eval tool is enabled if ANY backend is reachable. JS needs no preflight, so
	// we only probe Python/Ruby/Julia when JS is disabled — otherwise allowEval is
	// already true and per-backend availability is checked at first invocation.
	let pythonAvailable = true;
	let rubyAvailable = true;
	let juliaAvailable = true;
	const evalRequested = requestedTools === undefined || requestedTools.includes("eval");
	if (!skipEvalPreflight && !allowJs && evalRequested) {
		if (allowPython) {
			const availability = await logger.time(
				"createTools:pythonCheck",
				checkPythonKernelAvailability,
				session.cwd,
				session.settings.get("python.interpreter")?.trim() || undefined,
			);
			pythonAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Python kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowRuby) {
			const availability = await checkRubyKernelAvailability(
				session.cwd,
				session.settings.get("ruby.interpreter")?.trim() || undefined,
			);
			rubyAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Ruby kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowJulia) {
			const availability = await checkJuliaKernelAvailability(
				session.cwd,
				session.settings.get("julia.interpreter")?.trim() || undefined,
			);
			juliaAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Julia kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
	}

	const effectivePythonAllowed = allowPython && pythonAvailable;
	const effectiveRubyAllowed = allowRuby && rubyAvailable;
	const effectiveJuliaAllowed = allowJulia && juliaAvailable;
	// Eval is exposed whenever any backend is reachable. A backend may be
	// unreachable, in which case eval dispatches exclusively to the others.
	const allowEval = effectivePythonAllowed || allowJs || effectiveRubyAllowed || effectiveJuliaAllowed;

	// Checkpoint and rewind are a pair: listing one without the other strands
	// the agent (it can checkpoint but not rewind, or vice versa). Auto-include
	// the sister tool so a one-sided frontmatter `tools:` entry still works.
	// Unlike the AST/auto-learn convenience auto-includes below, this is a
	// safety pairing — it applies to restricted sessions too.
	if (requestedTools && session.settings.get("checkpoint.enabled")) {
		if (requestedTools.includes("checkpoint") && !requestedTools.includes("rewind")) {
			requestedTools.push("rewind");
		} else if (requestedTools.includes("rewind") && !requestedTools.includes("checkpoint")) {
			requestedTools.push("checkpoint");
		}
	}
	// Auto-include AST counterparts when their text-based sibling is present.
	// Restricted callers own the active list and must not have it widened.
	if (requestedTools && !restrictToolNames) {
		if (goalModeActive && !requestedTools.includes("goal")) {
			requestedTools.push("goal");
		}
		if (
			requestedTools.includes("grep") &&
			!requestedTools.includes("ast_grep") &&
			session.settings.get("astGrep.enabled")
		) {
			requestedTools.push("ast_grep");
		}
		if (
			requestedTools.includes("edit") &&
			!requestedTools.includes("ast_edit") &&
			session.settings.get("astEdit.enabled")
		) {
			requestedTools.push("ast_edit");
		}
		if (["hindsight", "mnemopi"].includes(session.settings.get("memory.backend") ?? "")) {
			for (const name of ["recall", "retain", "reflect"]) {
				if (!requestedTools.includes(name)) requestedTools.push(name);
			}
		}
		if (session.settings.get("memory.backend") === "mnemopi" && !requestedTools.includes("memory_edit")) {
			requestedTools.push("memory_edit");
		}
		if (externalThinkingActive && !requestedTools.includes("think")) {
			requestedTools.push("think");
		}
		// Auto-learn tools are gated by `autolearn.enabled` but, like the memory
		// tools above, must also be force-included into an explicit requestedTools
		// list so a restricted top-level session whose controller/guidance is
		// active still exposes the tools the nudge points at. Gated to top-level
		// (taskDepth 0): the controller only runs there, so a subagent's explicit
		// tool whitelist must never be silently widened with write-capable tools.
		if (session.settings.get("autolearn.enabled") && (session.taskDepth ?? 0) === 0) {
			if (!requestedTools.includes("manage_skill")) requestedTools.push("manage_skill");
			if (
				["hindsight", "mnemopi", "local"].includes(session.settings.get("memory.backend") ?? "") &&
				!requestedTools.includes("learn")
			) {
				requestedTools.push("learn");
			}
		}
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const isToolAllowed = (name: string) => {
		// Per-tool denylist (plugin component toggles): a tool on
		// `tools.disabled` never enters the slate, regardless of its own
		// enabled gate or force-inclusion paths below.
		const denylist = session.settings.get("tools.disabled");
		if (Array.isArray(denylist) && (denylist as string[]).includes(name)) return false;
		// An unloaded file-tools component removes its tool family from the slate.
		if (!isFileBackendToolAllowed(name)) return false;
		// Every other packaged tool follows the component that owns it: unloading
		// or denying that component removes the tool, exactly like the file
		// families above. Unowned tools stay implicitly available.
		if (!isToolOwnerActive(name)) return false;
		// Never in the default set. Explicitly activatable while goal.enabled and
		// no goal record exists yet — /guided-goal enables it so the agent can
		// finish the interview with `goal create`, which turns goal mode on. Once
		// a goal record exists, only an enabled goal keeps the tool: a completed
		// (exiting) or paused goal must stop advertising it on the next rebuild.
		if (name === "goal") {
			if (!goalEnabled || restrictToolNames) return false;
			const goalState = session.getGoalModeState?.();
			return goalState === undefined || goalState.enabled === true || goalState.goal.status === "dropped";
		}
		if (name === "lsp") return isCapabilityActive("tool", "lsp") && enableLsp && session.settings.get("lsp.enabled");
		if (name === "bash") return session.settings.get("bash.enabled");
		if (name === "eval") return allowEval;
		if (name === "debug") return session.settings.get("debug.enabled");
		if (name === "todo")
			return (!includeYield || session.prewalkArmed === true) && session.settings.get("todo.enabled");
		// Project knowledge (notes / todos / plans). The panel's three sections
		// share this store, so the tool is gated like any other data tool.
		if (name === "knowledge") return session.settings.get("knowledge.enabled");
		// Presentation tools (`widget`, `board`) moved to bundled Cordis
		// plugins; their switches are the `enabled` gates on those definitions.
		if (name === "glob") return session.settings.get("glob.enabled");
		if (name === "grep") return session.settings.get("grep.enabled");
		if (name === "github") return session.settings.get("github.enabled");
		if (name === "ast_grep") return session.settings.get("astGrep.enabled");
		if (name === "ast_edit") return session.settings.get("astEdit.enabled");
		if (name === "inspect_image") return isInspectImageToolActive(session);
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "security_scan") return session.settings.get("security.enabled");
		if (name === "think") return externalThinkingActive;
		if (name === "ask") return session.settings.get("ask.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "computer")
			return isCapabilityActive("tool", "computer") && session.settings.get("computer.enabled");
		if (name === "checkpoint" || name === "rewind")
			return (
				session.settings.get("checkpoint.enabled") &&
				((session.taskDepth ?? 0) === 0 || requestedTools !== undefined)
			);
		if (name === "hub") {
			return (
				!restrictToolNames && session.enableIrc !== false && isIrcEnabled(session.settings, session.taskDepth ?? 0)
			);
		}
		if (name === "retain" || name === "recall" || name === "reflect") {
			return ["hindsight", "mnemopi"].includes(session.settings.get("memory.backend") ?? "");
		}
		if (name === "memory_edit") return session.settings.get("memory.backend") === "mnemopi";
		if (name === "manage_skill")
			return (
				session.settings.get("autolearn.enabled") &&
				((session.taskDepth ?? 0) === 0 || requestedTools !== undefined)
			);
		if (name === "learn") {
			return (
				session.settings.get("autolearn.enabled") &&
				((session.taskDepth ?? 0) === 0 || requestedTools !== undefined) &&
				["hindsight", "mnemopi", "local"].includes(session.settings.get("memory.backend") ?? "")
			);
		}
		if (name === "task") {
			return canSpawnAtDepth(session.settings.get("task.maxRecursionDepth") ?? 2, session.taskDepth ?? 0);
		}
		return true;
	};
	if (includeYield && requestedTools && !requestedTools.includes("yield")) {
		requestedTools.push("yield");
	}

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));
	const baseEntries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.map(name => [name, allTools[name]] as const)
			: [
					...Object.entries(BUILTIN_TOOLS)
						.filter(([name]) => isToolAllowed(name))
						.map(([name, factory]) => [name, factory] as const),
					...(externalThinkingActive ? ([["think", HIDDEN_TOOLS.think]] as const) : []),
					...(includeYield ? ([["yield", HIDDEN_TOOLS.yield]] as const) : []),
					...(goalModeActive ? ([["goal", HIDDEN_TOOLS.goal]] as const) : []),
				];

	const activeToolNames = new Set(baseEntries.map(([name]) => name));
	if (session.setActiveToolNames) {
		session.setActiveToolNames(activeToolNames);
	} else {
		session.isToolActive = name => activeToolNames.has(name);
	}

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			// Layer resolution: a package-provided implementation shadows the core
			// factory. A session-layer registration (either track) already owns the
			// name — the tool classes yield via toolIsRegistered — so only the
			// plugin layer can redirect construction here; otherwise the factory runs.
			const provider = resolveToolImplementation(session, name);
			const build = provider ?? (factory as ToolFactory);
			const tool = await logger.time(`createTools:${name}`, build, session);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	let tools = baseResults.filter((r): r is Tool => r !== null);
	const toolRegistry = session.toolRegistry ?? new Map<string, Tool>();
	session.toolRegistry = toolRegistry;
	const builtInNames = new Set(tools.map(tool => tool.name));
	for (const tool of tools) toolRegistry.set(tool.name, tool);

	// Ordinary sessions use xd:// for discoverable built-ins, custom tools, and
	// MCP tools. Structured children must expose only their host-provided names,
	// so never allocate a registry that later SDK assembly could populate.
	// The transport rides read/write, so a session granted no write tool never
	// allocates xd:// state — its tools are exposed top-level directly instead
	// of auto-granting a write transport the session was denied.
	// Explicitly requested built-ins retain their top-level presentation.
	const xdevEnabled =
		!restrictToolNames && session.settings.get("tools.xdev") && tools.some(tool => tool.name === "write");
	const mountBuiltinTools = requestedTools === undefined;
	if (xdevEnabled) {
		const mountedNames = new Set<string>();
		const kept: Tool[] = [];
		for (const tool of tools) {
			const mountable = mountBuiltinTools && isMountableUnderXdev(tool) && tool.name in BUILTIN_TOOLS;
			if (mountable) mountedNames.add(tool.name);
			else kept.push(tool);
		}
		session.xdev = {
			tools: toolRegistry,
			mountedNames,
			builtInNames,
			isActive: name => session.isToolActive?.(name) === true,
		};
		tools = kept;
	}
	// Staged previews from deferrable tools (e.g. ast_edit) resolve through a
	// `write` to xd://resolve/reject, so retain write whenever one can stage.
	// xd:// mounting itself never registers write: sessions without a granted
	// write tool skip mounting entirely (see xdevEnabled above).
	const xdevMounted = xdevEnabled && (session.xdev?.mountedNames.size ?? 0) > 0;
	if (
		!restrictToolNames &&
		tools.some(tool => tool.deferrable === true) &&
		!tools.some(tool => tool.name === "write")
	) {
		const writeTool = await logger.time("createTools:write", BUILTIN_TOOLS.write, session);
		if (writeTool) {
			const wrapped = wrapToolWithMetaNotice(writeTool);
			tools.push(wrapped);
			toolRegistry.set(wrapped.name, wrapped);
			builtInNames.add(wrapped.name);
		}
	}
	if (!restrictToolNames && xdevMounted && !tools.some(tool => tool.name === "read")) {
		const readTool = await logger.time("createTools:read", BUILTIN_TOOLS.read, session);
		if (readTool) {
			const wrapped = wrapToolWithMetaNotice(readTool);
			tools.push(wrapped);
			toolRegistry.set(wrapped.name, wrapped);
			builtInNames.add(wrapped.name);
		}
	}
	if (xdevEnabled) {
		const finalActiveNames = new Set(tools.map(tool => tool.name));
		if (session.setActiveToolNames) session.setActiveToolNames(finalActiveNames);
		else session.isToolActive = name => finalActiveNames.has(name);
	}

	return tools;
}
