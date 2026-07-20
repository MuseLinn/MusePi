// ============================================================
// MusePi transcript — normalized message model (L1).
//
// The transcript is the single data source for everything that reads
// the conversation (chat view, export, resume hints, goal accounting).
// It is built from SessionEntry replay and owns normalized turns and
// interactions; rendering layers consume it instead of touching
// session messages ad hoc (kimi-code packages/transcript parity).
// ============================================================

export type InteractionKind =
	| "user"
	| "assistant"
	| "thinking"
	| "tool_call"
	| "tool_result"
	| "custom"
	| "meta";

export interface TranscriptInteraction {
	kind: InteractionKind;
	/** Session entry id this interaction originates from. */
	entryId: string;
	timestamp: string;
	/** user/assistant text (thinking lives in `thinking`). */
	text?: string;
	/** thinking content, when kind === "thinking". */
	thinking?: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	/** custom_message entries: whether pi renders them. */
	display?: boolean;
	/** meta entries carry their raw type (compaction/model_change/…). */
	metaType?: string;
}

export interface TranscriptTurn {
	/** Entry id of the user message that opened the turn. */
	id: string;
	startedAt: string;
	interactions: TranscriptInteraction[];
	/** Aggregates (recomputed by the store, not by ops). */
	toolCalls: number;
	hasError: boolean;
}

export interface Transcript {
	turns: TranscriptTurn[];
	/** entryId → (turnIndex, firstInteractionIndex, groupSize) for idempotent ops. */
	byEntryId: Map<string, { turn: number; interaction: number; count: number }>;
}

export function emptyTranscript(): Transcript {
	return { turns: [], byEntryId: new Map() };
}
