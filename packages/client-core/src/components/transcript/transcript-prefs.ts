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

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	try {
		const value = localStorage.getItem(key);
		return allowed.includes(value as T) ? (value as T) : fallback;
	} catch {
		// Storage unavailable (private mode, blocked origin): the default is
		// always a valid reading of the preference.
		return fallback;
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
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage full or blocked: the in-memory settings state still drives
		// the current render; only persistence is lost.
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
