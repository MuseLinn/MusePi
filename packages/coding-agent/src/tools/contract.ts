/**
 * The tool contract: what a tool implementation may depend on.
 *
 * This module is deliberately type-only and imports nothing from the tool
 * implementations. A capability package (`src/plugins/tool-*`) ships a
 * tool's implementation and needs {@link ToolSession} to build it; importing
 * that from the `tools` barrel would pull in every other tool class and close
 * an import cycle (barrel → package → barrel). The reference harness solves the
 * same problem the same way: the tools contract package has no tool
 * implementations in it, and `tool-bash` depends on that, never on a peer tool.
 *
 * The barrel re-exports everything here, so callers outside `src/tools/` see
 * one surface and need not know which module a name lives in.
 */
import type { Clipboard, InMemorySnapshotStore } from "@musepi/hashline";
import type { AgentOptions, AgentTelemetryConfig, AgentTool, AgentToolResult, PauseGate } from "@musepi/pi-agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily, ToolChoice } from "@musepi/pi-ai";
import type { AsyncJobManager } from "../async/job-manager";
import type { Rule } from "../capability/rule";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { DaemonCompletionNotification } from "../launch/protocol";
import type { MCPManager } from "../mcp";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { PlanModeState } from "../plan-mode/state";
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridge } from "../session/client-bridge";
import type { CustomMessage } from "../session/messages";
import type { UsageStatistics } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import type { AgentOutputManager } from "../task/output-manager";
import type { StructuredSubagentSchemaMode } from "../task/types";
import type { EventBus } from "../utils/event-bus";
import type { InspectImageMode } from "../utils/inspect-image-mode";
import type { WorkspaceTree } from "../workspace-tree";

/** Tool type (AgentTool from pi-ai) */
export type Tool = AgentTool<any, any, any>;

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoItem {
	content: string;
	status: TodoStatus;
	/** When `status === "blocked"`, an optional note on what the task is waiting for. */
	blocker?: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

/** Shared tool state consumed by the `xd://` presentation layer. */
export interface XdevState {
	/** Canonical session tool map; direct and device dispatch read the same instances. */
	readonly tools: Map<string, Tool>;
	/** Ordered names currently presented as mounted devices. */
	readonly mountedNames: Set<string>;
	/** Names originating from built-in factories, used only for prompt presentation. */
	readonly builtInNames: Set<string>;
	/** Whether a name is active at the top level. */
	readonly isActive: (name: string) => boolean;
	/** Optional execution-only decorator, such as the ACP permission gate. */
	decorateExecution?(tool: Tool): Tool;
}

/** Handles a plan proposal staged through `xd://propose`. */
export type PlanProposalHandler = (title: string) => Promise<AgentToolResult<unknown>>;

export interface CheckpointState {
	/** Number of in-memory messages at checkpoint (AFTER checkpoint tool result is appended) */
	checkpointMessageCount: number;
	/** Session entry ID at checkpoint (for session tree branching) */
	checkpointEntryId: string | null;
	/** Timestamp */
	startedAt: string;
}

export interface CompletedRewindState {
	/** Report retained after a successful rewind. */
	report: string;
	/** Timestamp for the checkpoint that was rewound. */
	startedAt: string;
	/** Timestamp when the rewind completed. */
	rewoundAt: string;
}

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

/** Image attachment handle exposed to tools for user-facing labels such as `Image #1`. */
export type ImageAttachmentEntry = {
	label: string;
	uri: string;
	image: ImageContent;
};

/**
 * A late LSP diagnostics result that arrived after the edit/write tool already
 * returned. Surfaced to the model and the transcript via
 * {@link ToolSession.queueDeferredDiagnostics}, batched through the session
 * yield queue like background-job results.
 */
export interface DeferredDiagnosticsEntry {
	/** Absolute path the diagnostics belong to (the renderer shortens it). */
	path: string;
	/** One-line severity summary, e.g. "2 errors". */
	summary: string;
	/** Formatted, ready-to-display diagnostic lines. */
	messages: string[];
	/** True when any message is error severity. */
	errored: boolean;
	/**
	 * Evaluated at injection time (in the dispatcher's stale check): drop the entry
	 * when a newer mutation to the same file has superseded it, so the model never
	 * sees diagnostics for stale content.
	 */
	isStale(): boolean;
}

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** The plugin generation this session joined (the agent scope for tool
	 *  providers). Scoped registrations shadow the process-global default; a
	 *  session built before its generation is known reads the default. */
	pluginScope?: string;
	/** Freeze gate for this session's agent scope (GUI daemon per-session
	 *  pause). Forwarded to subagents so a paused session's spawned loops
	 *  stay frozen too. Absent ⇒ the process-global gate applies. */
	pauseGate?: PauseGate;
	/** Additional workspace directories beyond cwd (multi-root), forwarded to subagents. */
	additionalDirectories?: string[];
	/** Whether UI is available */
	hasUI: boolean;
	/** Whether this session's UI renders throttled tool previews (the desktop
	 *  picture-in-picture). False for the TUI and headless runs even when
	 *  {@link hasUI} is true. */
	viewerSurface?: boolean;
	/**
	 * Host-injected UI context (TUI / RPC / daemon approval bridge). Subagents
	 * forward it so their approval and ask prompts land in the parent's UI.
	 * Read lazily: hosts attach it after session construction.
	 */
	uiContext?: ExtensionUIContext;
	/** Whether this session has begun disposal. */
	isDisposed?: () => boolean;
	/**
	 * Suppress the spawn specialization/coordination advisory appended to `task`
	 * results. Set by internal/programmatic callers (e.g. the commit agent's
	 * file-analysis fan-out) whose results are consumed by code — not by a model
	 * orchestrating further spawns — so the nudge would only be noise.
	 */
	suppressSpawnAdvisory?: boolean;
	/** Optional fetch implementation injected into the URL read pipeline (tests, proxies). Defaults to global fetch. */
	fetch?: FetchImpl;
	/** Provider credential resolver forwarded unchanged to restricted child sessions. */
	getApiKey?: AgentOptions["getApiKey"];
	/** Skip subprocess-kernel availability checks and warmup */
	skipPythonPreflight?: boolean;
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded workspace tree (forwarded to subagents to skip re-scanning) */
	workspaceTree?: WorkspaceTree;
	/** Pre-loaded skills */
	skills?: readonly Skill[];
	/** Rediscover live session skills after a tool mutates their backing files. */
	refreshSkills?: () => Promise<void>;
	/**
	 * Record that a skill's instructions entered the session (a `/skill:` load or
	 * a `skill://` read). The session admits the tools that skill owns from the
	 * next step.
	 */
	activateSkill?: (name: string) => Promise<void>;
	/** Whether a skill's instructions have entered this session. */
	isSkillActivated?: (name: string) => boolean;
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Pre-loaded rules (forwarded to subagents to skip re-discovery). */
	rules?: Rule[];
	/**
	 * Pre-discovered extension source paths. Forwarded to subagents so they
	 * skip the FS scan but still re-bind extensions to their own session-scoped
	 * `ExtensionAPI` (cwd, eventBus, runtime). Inline extension factories
	 * (`<inline-N>`) are NOT included — those are session-local.
	 */
	extensionPaths?: string[];
	/**
	 * Pre-discovered custom-tool source paths from `.omp/tools/`, `.claude/tools/`,
	 * plugins, etc. Forwarded to subagents so they skip the FS scan but still
	 * re-bind tools to their own session-scoped `CustomToolAPI`.
	 */
	customToolPaths?: ToolPathWithSource[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether LSP is limited to navigation and diagnostics. */
	lspReadOnly?: boolean;
	/** Whether this invocation may expose IRC. `false` removes it even for subagents. */
	enableIrc?: boolean;
	/**
	 * Whether MCP capabilities may be forwarded to child sessions. `false`
	 * prohibits inherited-manager and process-global MCP fallback.
	 */
	enableMCP?: boolean;
	/** Whether an edit-capable tool is available in this session (controls hashline output) */
	hasEditTool?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents). */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Whether to include the yield tool by default */
	requireYieldTool?: boolean;
	/** Session starts with a prewalk hand-off armed. Keeps `todo` in yield-gated
	 *  (subagent) registries: the prewalk plan nudge + todo gate need it. */
	prewalkArmed?: boolean;
	/**
	 * Constrain the active set to the caller's explicit built-in names (plus a
	 * required yield tool). Suppresses automatic tool-set expansion.
	 */
	restrictToolNames?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Get shared eval executor session ID. Subagents inherit this to share JS/Python/Ruby/Julia state. */
	getEvalSessionId?: () => string | null;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Parent session journal used by tools that persist runtime lifecycle state. */
	sessionManager?: Pick<SessionManager, "appendCustomEntry" | "ensureOnDisk" | "flush" | "getBranch" | "getEntries">;
	/** Get eval kernel owner ID for session-scoped retained-kernel cleanup. */
	getEvalKernelOwnerId?: () => string | null;
	/** Reject new eval work once session disposal has started. */
	assertEvalExecutionAllowed?: () => void;
	/** Track tool-owned eval work so session disposal can await/abort it like direct session eval runs. */
	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get Hindsight runtime state for this agent session. */
	getHindsightSessionState?: () => HindsightSessionState | undefined;
	/** Get Mnemopi runtime state for this agent session. */
	getMnemopiSessionState?: () => MnemopiSessionState | undefined;
	/**
	 * Invalidate the session's cached memory developer instructions and rebuild
	 * the base prompt. Called by tools that persist memory state (e.g. `learn`)
	 * so the next turn carries the update instead of the frozen snapshot.
	 */
	refreshMemoryInstructions?: () => Promise<void>;
	/** Agent identity used for IRC routing. Returns the registry id (e.g. "Main", "AuthLoader"). */
	getAgentId?: () => string | null;
	/** Look up a registered tool by name (used by the eval js backend's tool bridge). */
	getToolByName?: (name: string) => AgentTool | undefined;
	/** Return whether a built-in tool is active in this turn's tool set. */
	isToolActive?: (name: string) => boolean;
	/** Update the active built-in tool predicate when a session changes tools mid-run. */
	setActiveToolNames?: (names: Iterable<string>) => void;
	/** Canonical map containing every registered tool exactly once. */
	toolRegistry?: Map<string, Tool>;
	/** `xd://` presentation state backed by {@link toolRegistry}. */
	xdev?: XdevState;
	/** Agent registry for IRC routing across live sessions. */
	agentRegistry?: AgentRegistry;
	/** Idle→parked→revive lifecycle owner; lets the hub kill a non-job-backed agent registration. Default: AgentLifecycleManager.global(). */
	agentLifecycle?: () => AgentLifecycleManager;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Get the ArtifactManager backing this session (shared across parent + subagents). */
	getArtifactManager?: () => ArtifactManager | null;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Get the current session model object (provider/api capabilities), regardless of how it was chosen. */
	getActiveModel?: () => Model | undefined;
	/** Session-scoped inspect_image mode override set by `/vision`; wins over the persisted setting. */
	getInspectImageModeOverride?: () => InspectImageMode | undefined;
	/** Get the session's live per-family service tiers (undefined = none). Source of truth for subagent `tier.subagent: inherit`. */
	getServiceTierByFamily?: () => ServiceTierByFamily | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/**
	 * Async job manager scoped to this session.
	 *
	 * - Top-level session that constructed one: its own manager.
	 * - Subagent (`parentTaskPrefix` set): the parent's manager, so background
	 *   bash/task work and `onJobComplete` deliveries flow into the conversation
	 *   that spawned it.
	 * - Secondary in-process top-level session that found a singleton already
	 *   installed (issue #1923): `undefined`. Tools refuse async work rather
	 *   than silently route completions into the owning session's `yieldQueue`.
	 *
	 * Tools MUST use this instead of `AsyncJobManager.instance()` so a secondary
	 * session never borrows the owning session's manager by accident.
	 */
	asyncJobManager?: AsyncJobManager;
	/** MCP manager visible to subagents without relying on the process-global singleton. */
	mcpManager?: MCPManager;
	/** Extension runner owning this session's registered subagent types (see
	 *  `ctx.registerSubagent`). Absent in restricted sessions and hosts that
	 *  never built one; resolution then uses filesystem discovery only. */
	extensionRunner?: import("../extensibility/extensions/runner").ExtensionRunner;
	/** Local protocol root to propagate to nested subagents and eval-created agents. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Plan mode state (if active) */
	getPlanModeState?: () => PlanModeState | undefined;
	/** Path of the session's active plan reference (e.g. `local://<title>.md`); defaults to `local://PLAN.md`. */
	getPlanReferencePath?: () => string;
	/** Goal mode state (if active or paused) */
	getGoalModeState?: () => GoalModeState | undefined;
	/** Goal runtime for the active agent session. */
	getGoalRuntime?: () => GoalRuntime | undefined;
	/** Get cumulative session usage statistics (input/output tokens, cost). */
	getUsageStatistics?: () => UsageStatistics;
	/** Current per-turn token budget {total, spent, hard} for the eval `budget` helper. */
	getTurnBudget?: () => { total: number | null; spent: number; hard: boolean };
	/** Record output tokens consumed by an eval-spawned subagent toward the current turn budget. */
	recordEvalSubagentUsage?: (output: number) => void;
	/** Bridge to the connected client (e.g. ACP editor host). Tools should route fs/terminal/permission requests through this when available. */
	getClientBridge?: () => ClientBridge | undefined;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	/** The tool-choice queue used to force forthcoming tool invocations and carry invocation handlers. */
	getToolChoiceQueue?(): ToolChoiceQueue;
	/** Build a model-provider-specific ToolChoice that targets the named tool, or undefined if unsupported. */
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	/** Steer a hidden custom message into the conversation (e.g. a preview reminder). */
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	/** Peek the currently in-flight tool-choice queue directive's invocation handler. Used by
	 *  the `xd://resolve` and `xd://reject` dispatch to reach the pending action. */
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Peek the most-recently registered non-forcing pending preview invoker. A `write` to
	 *  `xd://resolve` or `xd://reject` dispatches to it so a staged preview resolves
	 *  WITHOUT forcing tool_choice — the agent-loop's SoftToolRequirement lifecycle owns
	 *  reminder injection and escalation. */
	peekPendingInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	/** Clear stale pending preview markers when a resolution dispatch cannot run them. */
	clearPendingInvokers?(): void;
	/** Peek the plan-proposal handler installed by plan mode. `xd://propose` dispatches the
	 *  written plan title to it. */
	peekPlanProposalHandler?(): PlanProposalHandler | undefined;
	/** Register or clear the plan-proposal handler. Passing `null` clears it. */
	setPlanProposalHandler?(handler: PlanProposalHandler | null): void;
	/** Get active checkpoint state if any. */
	getCheckpointState?: () => CheckpointState | undefined;
	/** Set or clear active checkpoint state. */
	setCheckpointState?: (state: CheckpointState | null) => void;
	/** Get the most recent completed rewind, if this session just rewound a checkpoint. */
	getLastCompletedRewind?: () => CompletedRewindState | undefined;

	/** Per-session snapshot store of file contents as last shown to the model
	 *  by `read`/`search`. Used by hashline anchor-stale recovery to
	 *  reconstruct the version the model authored anchors against when the
	 *  file changed out-of-band. Lazily initialized by `getFileSnapshotStore`. */
	fileSnapshotStore?: InMemorySnapshotStore;

	/** Per-session `CUT`/`PASTE` clipboard register shared across edit
	 *  calls. Lazily initialized by `getEditClipboard`. */
	editClipboard?: Clipboard;

	/** Per-session log of unresolved git merge conflict regions surfaced by
	 *  `read`. Each entry gets a stable id N referenced by `write conflict://N`
	 *  to splice the recorded region with replacement content. Lazily initialized
	 *  by `getConflictHistory`. */
	conflictHistory?: import("./conflict-detect").ConflictHistory;

	/** Per-session ledger of post-edit LSP diagnostics already surfaced to the
	 *  model for each file. Lazily initialized by `getDiagnosticsLedger`. */
	diagnosticsLedger?: import("../lsp/diagnostics-ledger").DiagnosticsLedger;

	/** Per-session ledger of consecutive byte-identical no-op edits, keyed by
	 *  canonical file path. The hashline executor escalates a soft no-op hint
	 *  to a thrown error once the same payload no-ops `NOOP_HARD_LIMIT` times,
	 *  breaking subagent loops that ignore the textual hint (issue #2081).
	 *  Lazily initialized by `getNoopLoopGuard`. */
	noopLoopGuard?: import("../edit/hashline/noop-loop-guard").NoopLoopGuard;

	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
	/** Queue a broker supervised-process completion for the owning session. */
	queueLaunchCompletion?(notification: DaemonCompletionNotification): Promise<void>;
	/** Register cleanup that runs when this session is disposed; returns a handle that removes the cleanup. */
	registerDisposeCallback?(callback: () => void): (() => void) | void;
	/** Register cleanup that runs when this session adopts a different session ID. */
	registerSessionChangeCallback?(callback: () => void): (() => void) | void;
	/** Queue late LSP diagnostics (arrived after an edit/write returned) to be shown
	 *  in the transcript and delivered to the model at the next yield, like background
	 *  job results. */
	queueDeferredDiagnostics?(entry: DeferredDiagnosticsEntry): void;
	/** Bump and return the session-global mutation counter for `path`. Edit/write
	 *  tools call this on every file mutation so stale late-diagnostics can be dropped. */
	bumpFileMutationVersion?(path: string): number;
	/** Read the current session-global mutation counter for `path` (0 if never mutated). */
	getFileMutationVersion?(path: string): number;
	/** Get the active OpenTelemetry config so subagent dispatch can forward
	 *  the parent's tracer/hooks with the subagent's own identity stamped. */
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	/** Return image attachments visible to tools for resolving labels such as `Image #1`. */
	getImageAttachments?: () => ImageAttachmentEntry[];
}

export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

/**
 * A plugin package supplying a built-in tool's implementation.
 *
 * The core factory table stays as the default (and the fallback when no
 * package is mounted), but a package that ships a tool family can take the
 * tool over. Ownership decides *whether* the tool may exist; the provider
 * decides *what runs*. Both are needed to make a tool genuinely pluggable
 * without breaking sessions where no package is mounted.
 */
export type ToolProvider = (session: ToolSession) => Tool | null | Promise<Tool | null>;
