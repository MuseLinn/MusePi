/**
 * Jump target resolution (defect P1-17).
 *
 * Every "put this row on screen" path used to key on the entry's
 * `timestamp`. Timestamps are NOT unique: two entries can share one
 * millisecond (an advisor note and the user's prompt land in the same tick,
 * second-precision history, optimistic echo rows), and every consumer
 * resolved with `findIndex` / `querySelector`, which returns the FIRST
 * match. A jump then landed on an earlier turn than the one asked for.
 *
 * Entry ids ARE unique, so id-keyed callers (turn rail, message tree,
 * trajectory/canvas, the context panel) pass `{ entryId }` and this module
 * only has to confirm the row is inside the loaded window.
 *
 * The one caller that cannot produce an id is the ⌘F find bar: the daemon's
 * `messages` table is keyed `(session_id, seq)` and stores no wire entry id,
 * so a hit comes back as a timestamp plus the matched text.
 *
 * That timestamp needs care — see `TIMESTAMP_WINDOW_MS`.
 */

/**
 * How close two stamps must be to count as "the same instant".
 *
 * They are produced by different code paths: the daemon stores the *wire
 * message's* numeric timestamp (`msg.timestamp`, epoch ms), while the
 * transcript entries carry an ISO string stamped at *entry* creation. The
 * two agree in practice but are not the same clock reading, so exact
 * equality is too strict — and a plain string/number comparison never
 * matches at all. A one-second window is far tighter than "any entry" while
 * tolerating that skew; when it admits more than one candidate, the hit's
 * matched text picks between them.
 */
const TIMESTAMP_WINDOW_MS = 1000;

/** Only the leading slice is compared: the daemon already truncates snippets. */
const MATCH_PREFIX = 60;

export type JumpTarget = { readonly entryId: string } | { readonly timestampMs: number; readonly snippet: string };

/**
 * Message text for snippet matching. Deliberately local and minimal rather
 * than importing the transcript renderer's `msgText` (not on the barrel, and
 * dragging a React renderer into a resolution helper would be wrong) — this
 * only needs the text blocks, for one comparison per collision.
 */
function entryText(entry: { message?: { content?: unknown }; content?: unknown }): string {
	const raw = entry.message?.content ?? entry.content;
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw)) return "";
	return raw
		.filter((b): b is { text?: unknown } => typeof b === "object" && b !== null)
		.map(b => (typeof b.text === "string" ? b.text : ""))
		.join(" ");
}

interface JumpRow {
	readonly id: string;
	readonly timestamp: string;
}

function epochMs(iso: string): number {
	const parsed = Date.parse(iso);
	return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/**
 * Resolve a jump target to a loaded entry id, or null when the target is not
 * in `entries` yet (the caller pages older chunks and retries).
 *
 * Null is the "keep paging" signal — never an error. P1-17's companion item
 * (visible failure feedback when the target is never found) is deliberately
 * not implemented here.
 */
export function resolveJumpEntryId(entries: readonly JumpRow[] | null | undefined, target: JumpTarget): string | null {
	const list = entries ?? [];
	if ("entryId" in target) {
		return list.some(e => e.id === target.entryId) ? target.entryId : null;
	}
	const near = list.filter(e => Math.abs(epochMs(e.timestamp) - target.timestampMs) <= TIMESTAMP_WINDOW_MS);
	if (near.length === 0) return null;
	if (near.length === 1) return near[0]!.id;
	// More than one candidate — the hit's text picks between them.
	const needle = target.snippet.trim().slice(0, MATCH_PREFIX);
	if (needle) {
		const hit = near.find(e =>
			entryText(e as { message?: { content?: unknown }; content?: unknown }).includes(needle),
		);
		if (hit) return hit.id;
	}
	// Still ambiguous (identical text, or a snippet we cannot match): keep the
	// historical first-match behaviour rather than dropping the jump.
	return near[0]!.id;
}
