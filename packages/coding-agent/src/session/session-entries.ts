import type { AgentMessage } from "@musepi/pi-agent-core";
import type { ImageContent, MessageAttribution, ServiceTierByFamily, TextContent, Usage } from "@musepi/pi-ai";
import type { StructuredSubagentSchemaMode } from "../task/types";
import type { CompactionMethod } from "./compaction-methods";

export const CURRENT_SESSION_VERSION = 3;

export const SESSION_TITLE_SLOT_BYTES = 256;

export const SESSION_TITLE_SLOT_ENTRY_TYPE = "title";

export const TITLE_CHANGE_ENTRY_TYPE = "title_change";

export type SessionTitleSource = "auto" | "user";

/** Fixed-width first-line slot carrying the mutable current session title. */
export interface SessionTitleSlotEntry {
	type: typeof SESSION_TITLE_SLOT_ENTRY_TYPE;
	v: 1;
	title: string;
	source?: SessionTitleSource;
	updatedAt: string;
	pad: string;
}

export const EPHEMERAL_MODEL_CHANGE_ROLE = "fallback";

export interface SessionHeader {
	type: "session";
	version?: number; // v1 sessions don't have this
	id: string;
	title?: string; // Auto-generated title from first message
	titleSource?: SessionTitleSource;
	timestamp: string;
	cwd: string;
	/**
	 * The agent preset this session runs (dsh's name for it).
	 *
	 * Older builds wrote the same value as `modeId`, which read as the approval
	 * mode (`tools.approvalMode`) although it never meant that. Both are read so a
	 * session saved by an older build still resumes with its preset; only
	 * `agentPreset` is written now.
	 */
	agentPreset?: string;
	/** @deprecated Read-only fallback for sessions written before `agentPreset`. */
	modeId?: string;
	/**
	 * Additional workspace directories beyond `cwd` (multi-root workspace).
	 * Absolute, normalized, deduplicated. Absent on legacy single-cwd sessions.
	 * See {@link SessionWorkspace} in `./session-workspace`.
	 */
	additionalDirectories?: string[];
	parentSession?: string;
	/** Prior absolute JSONL locations recorded by successful session moves. */
	previousSessionFiles?: string[];
	/** Provider prompt-cache identity inherited by exact-route full forks. */
	providerPromptCacheKey?: string;
}

/**
 * The preset a session header names, preferring the current field.
 *
 * One reader for both spellings: a header written before the rename carries
 * `modeId`, and returning `undefined` for those would drop the preset on resume.
 */
export function sessionHeaderPreset(header: SessionHeader | undefined | null): string | undefined {
	return header?.agentPreset ?? header?.modeId;
}

export interface NewSessionOptions {
	modeId?: string;
	parentSession?: string;
	/** Provider prompt-cache identity to seed on the new session header. */
	providerPromptCacheKey?: string;
	/** Skip flushing the current session and delete it instead of saving. */
	drop?: boolean;
	/** Additional workspace directories to seed on the new session. */
	additionalDirectories?: string[];
}

export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
	/**
	 * The user-configured selector at the time of this change: `"auto"` when auto
	 * mode was active, otherwise the concrete level. Absent on entries written
	 * before auto-mode persistence existed; readers fall back to `thinkingLevel`.
	 */
	configured?: string | null;
}

export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format */
	model: string;
	/** Role: "default", "smol", "slow", etc. Undefined treated as "default" */
	role?: string;
	/** True when this transition selected a retry-fallback model rather than the configured model. */
	resolvedModelIsFallback?: boolean;
}

export interface ServiceTierChangeEntry extends SessionEntryBase {
	type: "service_tier_change";
	serviceTier: ServiceTierByFamily | null;
}

/**
 * Usage from a model call that does not belong in the conversation transcript:
 * compaction summaries, handoffs, recaps and other side channels. It is never
 * sent to the model and never rendered in the transcript — it exists so their
 * spend counts in session totals and per-purpose reporting survives a restart.
 */
export interface ModelUsageEntry extends SessionEntryBase {
	type: "model_usage";
	/**
	 * What the call was for. A `compaction:<method>` name groups under its base
	 * in reporting (`compaction:remote`, `compaction:handoff`, …).
	 */
	purpose: string;
	/** Resolved model role used for the call, such as `smol`. */
	role?: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason: string;
	errorMessage?: string;
	/** Wall time of the request in milliseconds. */
	duration?: number;
}

/** A {@link ModelUsageEntry} as its writer supplies it; the session adds identity and time. */
export type ModelUsageRecord = Omit<ModelUsageEntry, keyof SessionEntryBase>;

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Estimated context tokens after the rewrite (display metadata). */
	tokensAfter?: number;
	/** Method that produced this entry; absent on legacy sessions and extension-provided compactions. */
	method?: CompactionMethod;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
	/** Hook-provided data to persist across compaction */
	preserveData?: Record<string, unknown>;
	/** True if generated by an extension, undefined/false if pi-generated (backward compatible) */
	fromExtension?: boolean;
	/**
	 * Dead-end warning from the post-pass progress guard: the pass completed
	 * but freed too little for maintenance to continue. Rendered on the
	 * compaction divider.
	 */
	warning?: string;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	/** Extension-specific data (not sent to LLM) */
	details?: T;
	/** True if generated by an extension, false if pi-generated */
	fromExtension?: boolean;
}

/**
 * Pure marker entry recorded by `/clear` (resetSessionContext). It carries no
 * payload — its presence on the branch is a durable boundary the collapsed
 * live transcript and the model-context rebuild start emission after, so a
 * rebuild (theme change, focus attach, /shake, resume) does not resurrect the
 * pre-reset conversation. The on-disk record and the plain `transcript:true`
 * export path keep the full pre-reset history.
 */
export interface ResetBoundaryEntry extends SessionEntryBase {
	type: "reset_boundary";
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context (ignored by buildSessionContext).
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	targetId: string;
	label: string | undefined;
}

/** Append-only audit entry recording a session title change. */
export interface TitleChangeEntry extends SessionEntryBase {
	type: typeof TITLE_CHANGE_ENTRY_TYPE;
	title: string;
	previousTitle?: string;
	source: SessionTitleSource;
	trigger?: string;
}

declare module "@musepi/pi-agent-core/compaction/entries" {
	interface CustomCompactionSessionEntries {
		titleChange: TitleChangeEntry;
		credentialPin: CredentialPinEntry;
		modelUsage: ModelUsageEntry;
	}
}

/** TTSR injection entry - tracks which time-traveling rules have been injected this session. */
export interface TtsrInjectionEntry extends SessionEntryBase {
	type: "ttsr_injection";
	/** Names of rules that were injected */
	injectedRules: string[];
}

/**
 * Records which OAuth account served this session's requests for a provider.
 *
 * Provider prompt caches (Anthropic in particular) are account-scoped, and the
 * auth store's session-sticky routing is process-local under a remote auth
 * broker, so resume must re-pin the same account to reuse the warm cache
 * prefix. Stores a sha-256 of the account + billing-scope tuple instead of
 * the raw email/uuid/org; note an unsalted digest of a guessable email is
 * still linkable, so exported sessions are pseudonymous, not anonymous.
 */
export interface CredentialPinEntry extends SessionEntryBase {
	type: "credential_pin";
	/** Provider id the pin applies to (e.g. "anthropic"). */
	provider: string;
	/** `credentialPinHash()` of the serving account's identity + scope tuple. */
	hash: string;
}

/** Session init entry - captures initial context for subagent sessions (debugging/replay). */
export interface SessionInitEntry extends SessionEntryBase {
	type: "session_init";
	/** Full system prompt sent to the model */
	systemPrompt: string;
	/** Initial task/user message */
	task: string;
	/** Tools available to the agent */
	tools: string[];
	/** Agent definition name (for example `scout` or `reviewer`). */
	agent?: string;
	/** Semantic model role declared by the agent, retained even after concrete model resolution. */
	modelRole?: string;
	/** Initially resolved provider/model selector for historical display. */
	resolvedModel?: string;
	/** Whether the agent definition is read-only, allowing an exact zero-LoC attribution. */
	readOnly?: boolean;
	/** Output schema if structured output was requested. */
	outputSchema?: unknown;
	/** Enforcement policy recorded with the output schema for faithful revival. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Whether revival must retain only the explicitly persisted tool names. */
	restrictToolNames?: boolean;
	/** Spawn allowlist the subagent ran with ("" = none, "*" = any, else CSV); absent on pre-spawns files. */
	spawns?: string;
	/** The agent's `readSummarize` setting (`false` = read summarization disabled); absent uses the session default. */
	readSummarize?: boolean;
	/** Effective advisor for this subagent: `"on"` = advisor-role model, else an explicit model pattern; absent = unadvised. */
	advisor?: string;
}

/** Mode change entry - tracks agent mode transitions (e.g. plan mode). */
export interface ModeChangeEntry extends SessionEntryBase {
	type: "mode_change";
	/** Current mode name, or "none" when exiting a mode */
	mode: string;
	/** Optional mode-specific data (e.g. plan file path) */
	data?: Record<string, unknown>;
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context.
 * The content participates in LLM context through convertToLlm().
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ServiceTierChangeEntry
	| CompactionEntry
	| ModelUsageEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| TitleChangeEntry
	| TtsrInjectionEntry
	| SessionInitEntry
	| ModeChangeEntry
	| CredentialPinEntry
	| ResetBoundaryEntry;

/** Raw logical file entry after loaders strip any fixed-width title slot. */
export type FileEntry = SessionHeader | SessionEntry;

/** Physical JSONL entry before slot-aware loaders fold the title slot. */
export type RawFileEntry = SessionTitleSlotEntry | FileEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
}

export interface UsageStatistics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	orchestrationInput: number;
	orchestrationOutput: number;
	orchestrationCacheRead: number;
	premiumRequests: number;
	cost: number;
	/**
	 * Spend of off-transcript calls (`model_usage` entries) folded into `cost`
	 * above, grouped by their base purpose: `compaction` covers every
	 * `compaction:<method>` record, so remote/handoff/summary spend is visible
	 * without listing each method. Absent when nothing was journaled.
	 */
	offTranscriptCost?: Record<string, number>;
}
