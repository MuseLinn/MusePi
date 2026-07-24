// MusePi LSP — public surface (pure core, zero host imports).

export { LspClient, LspRegistry, nodeSpawn, normalizeLspUriKey } from "./client.ts";
export type {
	LspClientInfo,
	LspRegistryOptions,
	LspSpawnedProcess,
	LspSpawnFn,
	PublishedDiagnostics,
	WaitForDiagnosticsOptions,
} from "./client.ts";
export { encodeLspMessage, LspMessageFramer } from "./protocol.ts";
export {
	getServersForFile,
	hasRootMarkerAncestor,
	hasRootMarkers,
	mergeServerOverrides,
	resolveCommand,
	resolveLspServers,
	which,
} from "./config.ts";
export { BUILTIN_LSP_SERVERS } from "./defaults.ts";
export { DiagnosticsLedger } from "./ledger.ts";
export type { FileDiagnosticsResult } from "./ledger.ts";
export { DeferredDiagnosticsCoordinator, renderDeferredDiagnostics } from "./deferred.ts";
export type { DeferredDiagnosticsEntry } from "./deferred.ts";
export type {
	LspDiagnostic,
	LspDocumentSymbol,
	LspHover,
	LspLocation,
	LspLocationLink,
	LspPosition,
	LspRange,
	LspServerConfig,
	LspServerOverride,
	LspSymbolInformation,
	ResolvedLspServer,
} from "./types.ts";
export {
	dedupeFormattedDiagnostics,
	detectLanguageId,
	diagnosticLineIdentity,
	extractHoverText,
	fileToUri,
	formatDiagnostic,
	formatDocumentSymbols,
	formatLocation,
	formatSymbolInformations,
	normalizeLocations,
	severityToString,
	sortDiagnostics,
	summarizeDiagnosticMessages,
	symbolKindToName,
	uriToFile,
} from "./utils.ts";
