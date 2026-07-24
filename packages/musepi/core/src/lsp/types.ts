// ============================================================
// MusePi LSP — protocol and server-config types (pure, host-agnostic).
//
// Only the LSP 3.17 surface this module actually speaks is declared:
// initialize handshake, textDocument sync, publishDiagnostics, and the
// definition/references/hover/documentSymbol requests. Everything is
// structural (no enums from external packages) so core stays dependency
// free.
// ============================================================

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange: LspRange;
	originSelectionRange?: LspRange;
}

export type LspDiagnosticSeverity = 1 | 2 | 3 | 4;

export interface LspDiagnostic {
	range: LspRange;
	severity?: LspDiagnosticSeverity;
	code?: number | string;
	source?: string;
	message: string;
}

export interface LspPublishDiagnosticsParams {
	uri: string;
	version?: number | null;
	diagnostics: LspDiagnostic[];
}

export interface LspDocumentSymbol {
	name: string;
	detail?: string;
	kind: number;
	range: LspRange;
	selectionRange: LspRange;
	children?: LspDocumentSymbol[];
}

export interface LspSymbolInformation {
	name: string;
	kind: number;
	location: LspLocation;
	containerName?: string;
}

export type LspMarkedString = string | { language: string; value: string };

export interface LspHover {
	contents: LspMarkedString | LspMarkedString[] | { kind: string; value: string };
	range?: LspRange;
}

export interface LspServerCapabilities {
	diagnosticProvider?: unknown;
	definitionProvider?: unknown;
	referencesProvider?: unknown;
	hoverProvider?: unknown;
	documentSymbolProvider?: unknown;
	[key: string]: unknown;
}

// =============================================================================
// Server configuration
// =============================================================================

/** Static description of one language server (built-in table or user override). */
export interface LspServerConfig {
	/** Command name as written in config (pre-resolution). */
	command: string;
	args?: string[];
	/** Extensions / filenames this server handles, e.g. [".ts", ".tsx"]. */
	fileTypes: string[];
	/** Files that mark a project root for this server (plain names or `*.ext` globs). */
	rootMarkers: string[];
	/** Linter-only servers rank behind type-aware servers for the same file. */
	isLinter?: boolean;
	disabled?: boolean;
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

/** User-facing override shape (musepi.lsp.servers). Every field optional. */
export interface LspServerOverride {
	command?: string;
	args?: string[];
	fileTypes?: string[];
	rootMarkers?: string[];
	isLinter?: boolean;
	disabled?: boolean;
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

/** A server that passed detection: root markers present AND binary resolved. */
export interface ResolvedLspServer extends LspServerConfig {
	/** Server name in the merged table. */
	name: string;
	/** Absolute (or PATH-found) executable actually spawned. */
	resolvedCommand: string;
	/** Where this entry came from — reported by the `status` action. */
	source: "builtin" | "override";
}

// =============================================================================
// JSON-RPC wire shapes
// =============================================================================

export type LspJsonRpcId = number | string;

export interface LspJsonRpcRequest {
	jsonrpc: "2.0";
	id: LspJsonRpcId;
	method: string;
	params?: unknown;
}

export interface LspJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface LspJsonRpcResponse {
	jsonrpc: "2.0";
	id: LspJsonRpcId;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}
