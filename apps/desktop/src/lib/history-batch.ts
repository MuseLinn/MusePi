import { isTurnStartEntry, type SessionEntry } from "@musepi/pi-wire";

/**
 * Turn-aligned history backfill — openchamber `loadOlderPage` parity.
 *
 * The client pages older transcript history in batches, and a naive batch
 * boundary is arbitrary: the oldest loaded turn is then a FRAGMENT, so the
 * rail's top tick represents a turn whose earlier half is not loaded and
 * jumping to it lands mid-turn. Upstream therefore walks back until the
 * batch's oldest entry is a turn start, then commits the whole batch
 * atomically so a failed follow-up read leaves the previous window and its
 * cursor untouched.
 *
 * Two properties worth preserving if this is ever rewritten:
 *
 *   - The daemon cursor stays authoritative. Alignment only decides HOW MANY
 *     extra pages to read; it never invents or rewrites an anchor.
 *   - The extra reads are bounded (`HISTORY_TURN_ALIGNMENT_EXTRA_PAGES`), and
 *     a cursor already asked for stops the walk instead of replaying a page.
 *
 * Deliberate divergence from upstream: their alignment test is "is a user
 * message", ours is `isTurnStartEntry` — a user message OR a displayed advisor
 * note. That is this repo's turn boundary everywhere else (rail, trajectory
 * map, the daemon's turn index), and an advisor note genuinely opens a turn
 * because agent-initiated rounds have no user prompt. A user-only test would
 * still leave the oldest turn half-loaded in exactly the sessions whose first
 * turn is an advisor note.
 */

/** Messages per RPC. Matches upstream; one page is several screens of transcript. */
export const HISTORY_PAGE_MESSAGES = 100;

/** Upper bound on alignment reads per interactive batch (upstream's cap). */
export const HISTORY_TURN_ALIGNMENT_EXTRA_PAGES = 2;

/** The subset of the `session.history` response this walk needs. */
export interface HistoryPageLike {
	entries: SessionEntry[];
	hasMore: boolean;
	remaining: number;
	nextBeforeId?: string | null;
	/** The daemon no longer recognises the cursor (compaction dropped the
	 *  anchor). Paging must stop rather than re-issue the same cursor. */
	stale?: boolean;
}

export type FetchHistoryPage = (beforeId: string) => Promise<HistoryPageLike | null>;

export interface HistoryBatch {
	/** Oldest-first. Empty when the daemon reported the cursor stale. */
	entries: SessionEntry[];
	remaining: number;
	nextBeforeId: string | null;
	/** The cursor was refused; the caller must stop offering paging. */
	stale: boolean;
}

const EMPTY: HistoryBatch = {
	entries: [],
	remaining: 0,
	nextBeforeId: null,
	stale: false,
};

/**
 * Read one interactive batch, walking back until it starts on a turn
 * boundary. Never throws for a refused or empty page — those are outcomes
 * the caller has to render, not errors.
 */
export async function loadAlignedHistoryBatch(fetchPage: FetchHistoryPage, firstCursor: string): Promise<HistoryBatch> {
	let page = await fetchPage(firstCursor);
	if (!page) return EMPTY;
	if (page.stale) return { ...EMPTY, stale: true };

	// Each page arrives oldest-first, so the batch's oldest entry is index 0
	// once the extra pages are prepended.
	const batch: SessionEntry[] = [...page.entries];
	const visited = new Set<string>([firstCursor]);

	for (let extra = 0; extra < HISTORY_TURN_ALIGNMENT_EXTRA_PAGES; extra++) {
		if (!page.hasMore || batch.length === 0) break;
		if (isTurnStartEntry(batch[0])) break;
		const next = page.nextBeforeId ?? null;
		if (!next || visited.has(next)) break;
		visited.add(next);
		const older = await fetchPage(next);
		if (!older) break;
		if (older.stale) return { ...EMPTY, stale: true };
		// An empty page that still claims history is a stalled cursor: stop
		// rather than spin on it.
		if (older.entries.length === 0 && older.hasMore) break;
		batch.unshift(...older.entries);
		page = older;
	}

	if (batch.length === 0) return EMPTY;
	return {
		entries: batch,
		remaining: page.remaining,
		nextBeforeId: page.nextBeforeId ?? null,
		stale: false,
	};
}
