// ============================================================
// MusePi tool-select (progressive tool disclosure) — shared types.
//
// Mirrors kimi-code's `toolSelect` domain semantics onto pi's native
// deferred-tools wire mechanism (`ToolResultMessage.addedToolNames`):
// the loaded-tool ledger is the session history itself, so undo,
// compaction and resume self-heal by re-folding. Zero host imports.
// ============================================================

/** Minimal model reference used for gate evaluation. */
export interface ToolSelectModelRef {
	provider: string;
	id: string;
	/** Provider compat capabilities; `deferredToolsMode: "kimi"` marks native support. */
	deferredToolsMode?: string;
}

/** Gate configuration (musepi.toolSelect settings). */
export interface ToolSelectGateConfig {
	/** Master switch, default off (experimental). */
	enabled?: boolean;
	/**
	 * Model allowlist fallback for models whose catalog does not declare a
	 * deferred-tools capability. Entries are `provider/model` or a bare model id.
	 */
	models?: string[];
}

/** A registered tool with its origin source (builtin/sdk/extension/...). */
export interface ToolEntry {
	name: string;
	source: string;
}

/** A history message that may carry deferred-tool load markers. */
export interface AddedToolsCarrier {
	role: string;
	addedToolNames?: string[];
}

/** Three-way split of a select_tools request (mirrors kimi's LoadToolsResult). */
export interface LoadPlan {
	/** Deferrable tools that will become active. */
	toLoad: string[];
	/** Requested tools that are already active. */
	alreadyAvailable: string[];
	/** Names that are neither active nor deferrable. */
	unknown: string[];
}
