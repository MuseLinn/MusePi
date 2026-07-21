// @musepi/core — barrel for the native integrations in coding-agent.
export { goalManager, GoalManager } from "./goal/index.ts";
export { registerGoalTools } from "./goal/tools.ts";
export { currentGoal, GOAL_ENTRY_TYPE } from "./goal/types.ts";
export type { GoalSnapshot } from "./goal/types.ts";
export type { PersistencePort, ScopeDirs, SessionEntryLike } from "./ports.ts";
export { mergeMusepiSettings, MUSEPI_DEFAULTS, MUSEPI_SETTINGS_DOCS } from "./config/schema.ts";
export type { MusepiSettings, ResolvedMusepiSettings } from "./config/schema.ts";
export {
	isModelRole,
	MODEL_ROLES,
	parseRoleModelSpec,
	resolveCandidatesForRole,
	resolveCycleOrder,
	resolveFallbackChain,
	resolveModelForRole,
} from "./model-roles/index.ts";
export type { ModelRole, ModelRolesConfig, RoleModelSpec, RoleThinkingLevel } from "./model-roles/index.ts";
export { HashlineEngine, SnapshotStore } from "./hashline/index.ts";
export type {
	HashlineApplyResult,
	HashlineFs,
	SectionApplyResult,
	Snapshot,
} from "./hashline/index.ts";
export { computeFileHash, formatHashlineHeader, formatNumberedLine } from "./hashline/index.ts";
export { HASHLINE_EDIT_DESCRIPTION, HASHLINE_EDIT_PROMPT_GUIDELINES } from "./hashline/index.ts";
export {
	activeNamesOnDisable,
	activeNamesOnEnable,
	foldLoadedToolNames,
	isToolSelectEnabled,
	partitionTools,
	planLoad,
	reconcileResumedActiveNames,
	renderLoadableToolsAnnouncement,
	renderLoadResult,
	SELECT_TOOLS_DESCRIPTION,
	SELECT_TOOLS_TOOL_NAME,
} from "./tool-select/index.ts";
export type {
	AddedToolsCarrier,
	LoadPlan,
	ToolEntry,
	ToolSelectGateConfig,
	ToolSelectModelRef,
} from "./tool-select/index.ts";
export {
	BUILTIN_LSP_SERVERS,
	DeferredDiagnosticsCoordinator,
	DiagnosticsLedger,
	dedupeFormattedDiagnostics,
	detectLanguageId,
	extractHoverText,
	fileToUri,
	formatDiagnostic,
	formatDocumentSymbols,
	formatLocation,
	formatSymbolInformations,
	getServersForFile,
	hasRootMarkerAncestor,
	mergeServerOverrides,
	normalizeLocations,
	renderDeferredDiagnostics,
	resolveCommand,
	resolveLspServers,
	LspClient,
	LspRegistry,
	severityToString,
	sortDiagnostics,
	summarizeDiagnosticMessages,
	uriToFile,
} from "./lsp/index.ts";
export type {
	DeferredDiagnosticsEntry,
	FileDiagnosticsResult,
	LspClientInfo,
	LspDiagnostic,
	LspDocumentSymbol,
	LspHover,
	LspLocation,
	LspRegistryOptions,
	LspServerConfig,
	LspServerOverride,
	LspSpawnFn,
	LspSymbolInformation,
	ResolvedLspServer,
} from "./lsp/index.ts";
export type { MusepiLspServerSettings, MusepiLspSettings } from "./config/schema.ts";
