// ============================================================
// Tool Select — shared types
// ============================================================

/** Minimal model reference used for gate evaluation. */
export interface ToolSelectModelRef {
	provider: string;
	id: string;
	/** Provider compat capabilities; `deferredToolsMode: "kimi"` marks native support. */
	deferredToolsMode?: string;
}

/** Gate configuration (toolSelect settings). */
export interface ToolSelectGateConfig {
	/** Master switch, default off (experimental). */
	enabled?: boolean;
	/** Model allowlist — models that should use disclosure even without native capability. */
	models?: string[];
	/** Extra tool names to force-defer regardless of source. */
	defer?: string[];
}

/** A tool entry from the registry, filtered for deferrability. */
export interface ToolEntry {
	name: string;
	source: string;
}

/** Role that carries `addedToolNames` on tool results. */
export interface AddedToolsCarrier {
	role: string;
	addedToolNames?: string[];
}

/** Three-way load plan for a `select_tools` request. */
export interface LoadPlan {
	toLoad: string[];
	alreadyAvailable: string[];
	unknown: string[];
}
