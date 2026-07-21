// ============================================================
// MusePi snapcompact — deterministic context compression, types.
//
// Text-mode port of OMP's bitmap-frame snapcompact: the mechanism
// (serialize → unfold prior archive → edge-verbatim + drop-oldest layout
// → static reading-guide summary) is preserved; the PNG frame rendering
// (pi-natives Rust) is replaced by fixed-capacity text frames, with
// chars/4 as the token estimate (same heuristic pi itself uses).
// Zero host imports.
// ============================================================

/** Minimal LLM-ish message shape the engine serializes. The host maps
 *  pi's converted messages onto this; extra fields are ignored. */
export interface SnapMessage {
	role: "user" | "assistant" | "toolResult";
	/** String for simple user text; block list otherwise. */
	content: string | SnapContentBlock[];
	/** toolResult only: id of the originating call. */
	toolCallId?: string;
	/** toolResult only: errors are never elided as useless. */
	isError?: boolean;
	/** toolResult only: harness flag for contextually useless output. */
	useless?: boolean;
}

export type SnapContentBlock =
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; intent?: string };

/** Character budgets applied while serializing discarded history. */
export interface SerializeOptions {
	/** Per-tool-result cap. Default 2000. */
	toolResultMaxChars?: number;
	/** Per-argument-value cap. Default 500. */
	toolArgMaxChars?: number;
	/** Whole-argument-list cap per call. Default 2000. */
	toolCallMaxChars?: number;
	/** Head share of each truncation budget. Default 0.6 (tail keeps errors). */
	truncateHeadRatio?: number;
}

/** File operations extracted by the host from the discarded history. */
export interface SnapFileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/** Input to one deterministic compaction pass. */
export interface SnapCompactionInput {
	/** Messages being discarded (messagesToSummarize + turnPrefixMessages). */
	messages: SnapMessage[];
	/** Summary of the previous (possibly LLM-generated) compaction. */
	previousSummary?: string;
	/** Persisted archive state from the previous snapcompact pass, if any. */
	previousArchive?: SnapArchiveState;
	/** File operations over the discarded history. */
	fileOps: SnapFileOperations;
	/** Total archive character budget (edges + middle). Default 40000. */
	archiveMaxChars?: number;
	/** Serialization caps override. */
	serialize?: SerializeOptions;
}

/** Archive state persisted between passes (host stores it in entry details). */
export interface SnapArchiveState {
	/** Kept archive source, oldest to newest, after layout. */
	text: string;
	/** Characters dropped so far to respect the archive budget. */
	truncatedChars: number;
	/** Engine version, for forward compatibility of persisted state. */
	version: number;
}

/** One text frame: a fixed-capacity page of the archive middle. */
export interface SnapFrame {
	index: number;
	chars: number;
}

export interface SnapCompactionResult {
	/** Full summary text entering the rebuilt context (lead-in + guide +
	 *  archive pages + FILES section). */
	summary: string;
	/** One-line human description of what the pass did. */
	shortSummary: string;
	/** Archive state to persist on the compaction entry. */
	archive: SnapArchiveState;
	/** Frame layout of the archive middle (metadata only, no rendering). */
	frames: SnapFrame[];
	/** Characters in the archive region of the summary. */
	archiveChars: number;
	/** Read-only files seen in the discarded history. */
	readFiles: string[];
	/** Written/edited files seen in the discarded history. */
	modifiedFiles: string[];
}
