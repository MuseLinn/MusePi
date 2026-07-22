// @musepi/core — barrel for the native integrations in coding-agent.
export { goalManager, GoalManager } from "./goal/index.ts";
export { registerGoalTools } from "./goal/tools.ts";
export { goalState, GOAL_ENTRY_TYPE } from "./goal/types.ts";
export type { GoalSnapshot } from "./goal/types.ts";
export type { PersistencePort, ScopeDirs, SessionEntryLike } from "./ports.ts";
export { mergeMusepiSettings, MUSEPI_DEFAULTS, MUSEPI_SETTINGS_DOCS } from "./config/schema.ts";
export type { MusepiAdvisorSettings, MusepiSettings, ResolvedMusepiSettings } from "./config/schema.ts";
export {
	ADVISOR_DEFAULT_MAX_CONTEXT_CHARS,
	ADVISOR_DEFAULT_TOOL_RESULT_MAX_CHARS,
	ADVISOR_GUIDANCE,
	ADVISOR_HEAD_ANCHOR_CHARS,
	ADVISOR_SYSTEM_PROMPT,
	buildAdvisorTranscript,
	buildAdvisorUserPrompt,
	formatAdvisorResult,
	isAdvisorEnabled,
	resolveAdvisorModelSpec,
} from "./advisor/index.ts";
export type {
	AdvisorGateConfig,
	AdvisorModelConfig,
	AdvisorPromptInput,
	AdvisorRoleChain,
	AdvisorTranscriptOptions,
} from "./advisor/index.ts";
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
export { cleanupIsolation, mergeIsolation, prepareIsolation } from "./swarm/isolation.ts";
export type {
	MergeOutcome,
	NoIsolation,
	PreparedIsolation,
	WorktreeBaseline,
	WorktreeIsolation,
} from "./swarm/isolation.ts";
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
export {
	buildMemoryInjection,
	computeProjectId,
	editEntry,
	isEmptyMemory,
	MEMORY_SECTIONS,
	memoryPaths,
	memorySkeleton,
	readMemoryFile,
	retainEntry,
	searchIndex,
	searchMemory,
	tokenize,
	truncateToBudget,
	writeMemoryFile,
} from "./memory/index.ts";
export type { MemoryCaps, MemorySearchHit, MemorySection } from "./memory/index.ts";
export {
	computeFileLists,
	DEFAULT_ARCHIVE_MAX_CHARS,
	estimateTokensFromChars,
	formatFileList,
	formatFilesSection,
	FRAME_CHAR_CAPACITY,
	planArchive,
	serializeConversation,
	SNAP_ARCHIVE_VERSION,
	snapCompact,
	truncateForArchive,
} from "./snapcompact/index.ts";
export type {
	ArchiveLayout,
	SerializeOptions,
	SnapArchiveState,
	SnapCompactionInput,
	SnapContentBlock,
	SnapCompactionResult,
	SnapFileOperations,
	SnapFrame,
	SnapMessage,
} from "./snapcompact/index.ts";
export type { MusepiCompactionSettings } from "./config/schema.ts";
export {
	computeUndoPlan,
	formatNothingToUndoMessage,
	formatUndoLimitMessage,
	listUndoAnchors,
	resolveUndoAvailability,
	undoAnchorLabel,
	undoRefillText,
} from "./undo.ts";
export type { UndoAnchor, UndoAvailability, UndoEntry, UndoEntryKind, UndoPlan } from "./undo.ts";
export {
	BEL,
	buildTerminalNotificationSequences,
	ESC,
	formatNotification,
	isInsideTmux,
	MAX_TERMINAL_NOTIFICATION_MESSAGE_LENGTH,
	notifyTerminalOnce,
	ST,
	supportsOsc9Notification,
} from "./notify.ts";
export type {
	NotificationBuildOptions,
	NotificationCondition,
	NotificationGateOptions,
	NotificationGateState,
	TerminalNotification,
} from "./notify.ts";
