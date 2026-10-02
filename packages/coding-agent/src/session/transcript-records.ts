/**
 * Transcript record families.
 *
 * A session file carries far more than `message` rows: `custom_message`
 * (advisor cards, hook notices, collab prompts, skill prompts), compaction,
 * branch_summary, model_change, thinking_level_change, title_change, label,
 * reset_boundary… A surface that renders "the conversation" by filtering to
 * `type === "message"` silently drops every one of them — advisor cards vanish
 * with no placeholder and no error. daemon/jsonl-snapshot.ts records the same
 * lesson for the GUI side of the wire.
 *
 * Two things live here so they cannot drift apart:
 *
 *   - which entry types are bookkeeping with no conversation content. This
 *     list was a function-local const in tree-selector.ts and a SEPARATE,
 *     already-diverged copy in export/html/template.js (four types missing);
 *   - how a file-level `custom_message` entry becomes the in-memory
 *     `role: "custom"` message the TUI transcript builder actually renders.
 *     On disk the payload sits on the entry; in memory it sits inside
 *     `message`, which is why the file→memory hop needs a real converter
 *     rather than a cast.
 */
import type { CustomMessageEntry, FileEntry, SessionMessageEntry } from "./session-entries";

/**
 * Entry types with no conversation content: settings, bookkeeping and
 * bookkeeping-only transitions. Surfaces that offer an "all entries" mode
 * (the session tree's) hide these by default; surfaces that render a
 * conversation must simply skip them.
 *
 * `custom_message` is deliberately NOT here — it carries advisor cards and
 * hook notices that readers are meant to see. Adding it is the exact bug this
 * module exists to prevent.
 */
export const HIDDEN_BY_DEFAULT_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"label",
	"custom",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"title_change",
	"credential_pin",
	"session_init",
	"ttsr_injection",
	"mode_change",
	"reset_boundary",
]);

/** True for a bookkeeping entry the default views skip (see the type list). */
export function isHiddenByDefaultEntry(entry: { type: string }): boolean {
	return HIDDEN_BY_DEFAULT_ENTRY_TYPES.has(entry.type);
}

/** A file entry the transcript builder can render: a message, or a custom_message. */
export type RenderableTranscriptEntry = SessionMessageEntry | CustomMessageEntry;

export function isRenderableTranscriptEntry(entry: FileEntry): entry is RenderableTranscriptEntry {
	return entry.type === "message" || entry.type === "custom_message";
}

/**
 * Lift a `custom_message` file entry into the `role: "custom"` message shape
 * the transcript builder renders. Mirrors what #persistMessageEnd writes on
 * the way out (customType / content / display / details / attribution), with
 * the entry-level id / parentId / timestamp re-wrapped and the numeric
 * timestamp the in-memory message type wants.
 */
export function customMessageEntryToSessionMessage(entry: CustomMessageEntry): SessionMessageEntry {
	const parsed = Date.parse(entry.timestamp);
	return {
		type: "message",
		id: entry.id,
		parentId: entry.parentId,
		timestamp: entry.timestamp,
		message: {
			role: "custom",
			customType: entry.customType,
			content: entry.content,
			display: entry.display,
			details: entry.details,
			attribution: entry.attribution,
			timestamp: Number.isNaN(parsed) ? Date.now() : parsed,
		},
	};
}

/** Normalize a renderable entry into the message entry the builder consumes. */
export function toRenderableSessionMessage(entry: RenderableTranscriptEntry): SessionMessageEntry {
	return entry.type === "custom_message" ? customMessageEntryToSessionMessage(entry) : entry;
}

/**
 * Every conversation-bearing entry of a parsed transcript, in file order.
 *
 * Bookkeeping entries are skipped; `custom_message` is kept. This is the
 * selection rule surfaces should share — the alternative (a `type === "message"`
 * gate) loses advisor cards with no signal.
 */
export function extractRenderableEntries(entries: readonly FileEntry[]): SessionMessageEntry[] {
	const out: SessionMessageEntry[] = [];
	for (const entry of entries) {
		if (isRenderableTranscriptEntry(entry)) out.push(toRenderableSessionMessage(entry));
	}
	return out;
}
