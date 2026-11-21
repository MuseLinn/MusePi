/**
 * Transcript-reading preferences: how much of a finished turn's working
 * process the transcript shows, when a completed turn folds, and which
 * assistant replies stay visible once it does.
 *
 * Three independent dimensions, stored side by side in the renderer-local
 * settings channel (like every other transcript preference). The defaults
 * reproduce the pre-existing single-policy behaviour exactly:
 * `detailed` + `completion` + `final` — historical rounds fold when they
 * finish, the in-flight turn stays flat, and only the round's final answer
 * survives the fold.
 */

/** Work-details presentation modes a reader can choose. */
export const TRANSCRIPT_VIEW_MODES = ["compact", "standard", "detailed", "verbose"] as const;

/** Work-details presentation mode. */
export type TranscriptViewMode = (typeof TRANSCRIPT_VIEW_MODES)[number];

/** Points at which a completed round returns to its historical presentation. */
export const COLLAPSE_TIMINGS = ["completion", "next-input"] as const;

/** When a completed round returns to its historical presentation. */
export type CollapseTiming = (typeof COLLAPSE_TIMINGS)[number];

/** Assistant replies kept visible while a completed round folds its process. */
export const FOLDED_REPLIES = ["all", "final"] as const;

/** Which assistant replies stay visible while a completed round folds. */
export type FoldedReplies = (typeof FOLDED_REPLIES)[number];

/** Default mode: historical rounds fold, the in-flight turn stays flat. */
export const DEFAULT_TRANSCRIPT_VIEW_MODE: TranscriptViewMode = "detailed";

/** Default timing: a round folds as soon as it completes. */
export const DEFAULT_COLLAPSE_TIMING: CollapseTiming = "completion";

/** Default replies: only the round's final answer survives the fold. */
export const DEFAULT_FOLDED_REPLIES: FoldedReplies = "final";

/** Stored mode key (Settings → 聊天 → 会话). */
export const TRANSCRIPT_VIEW_KEY = "musepi-gui-chat-transcript-view";

/** Stored collapse-timing key. */
export const COLLAPSE_TIMING_KEY = "musepi-gui-chat-collapse-timing";

/** Stored folded-reply key. */
export const FOLDED_REPLIES_KEY = "musepi-gui-chat-folded-replies";

/** Companion event for same-document preference changes (localStorage events
 *  do not fire in the writing document). The transcript re-reads on it. */
export const TRANSCRIPT_PREFS_CHANGED_EVENT = "musepi-transcript-prefs-changed";

/** The three prefs as one object — the unit the policy derives from. */
export interface TranscriptPrefs {
	transcriptView: TranscriptViewMode;
	collapseTiming: CollapseTiming;
	foldedReplies: FoldedReplies;
}

/** In-memory mirror of the values this session has read or written. Storage
 *  can be blocked or full (private mode, quota, sandboxed origin); the mirror
 *  keeps the reader's choice effective for this session instead of silently
 *  reverting the row to an older stored value. */
const memory = new Map<string, string>();

/** Keys whose last write failed. Their mirror value outranks a stale stored
 *  value until a later write succeeds. */
const unsynced = new Set<string>();

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	const remembered = memory.get(key);
	// A failed write means the stored value is older than the reader's choice.
	if (unsynced.has(key) && allowed.includes(remembered as T)) return remembered as T;
	try {
		const value = localStorage.getItem(key);
		const next = allowed.includes(value as T) ? (value as T) : fallback;
		memory.set(key, next);
		return next;
	} catch {
		// Storage unreadable: the session's last known choice is the best
		// available answer, then the default.
		return allowed.includes(remembered as T) ? (remembered as T) : fallback;
	}
}

/** Current preferences; unknown, missing, or unreadable values use defaults. */
export function readTranscriptPrefs(): TranscriptPrefs {
	return {
		transcriptView: readEnum(TRANSCRIPT_VIEW_KEY, TRANSCRIPT_VIEW_MODES, DEFAULT_TRANSCRIPT_VIEW_MODE),
		collapseTiming: readEnum(COLLAPSE_TIMING_KEY, COLLAPSE_TIMINGS, DEFAULT_COLLAPSE_TIMING),
		foldedReplies: readEnum(FOLDED_REPLIES_KEY, FOLDED_REPLIES, DEFAULT_FOLDED_REPLIES),
	};
}

function writePref(key: string, value: string): void {
	// Mirror first: when the write fails the in-memory choice still drives
	// this session's transcript and settings row; only persistence is lost.
	memory.set(key, value);
	try {
		localStorage.setItem(key, value);
		unsynced.delete(key);
	} catch {
		// Storage full or blocked — the mirror above is the fallback until a
		// later write succeeds.
		unsynced.add(key);
	}
	window.dispatchEvent(new Event(TRANSCRIPT_PREFS_CHANGED_EVENT));
}

/** Persist the work-details mode and wake every mounted transcript. */
export function setTranscriptView(mode: TranscriptViewMode): void {
	writePref(TRANSCRIPT_VIEW_KEY, mode);
}

/** Persist the collapse timing. */
export function setCollapseTiming(timing: CollapseTiming): void {
	writePref(COLLAPSE_TIMING_KEY, timing);
}

/** Persist which assistant replies survive a fold. */
export function setFoldedReplies(replies: FoldedReplies): void {
	writePref(FOLDED_REPLIES_KEY, replies);
}
