/**
 * Canonical SDK-transcript → session-snapshot projection (P0-5).
 *
 * A CLI-created / archived session that this daemon never journaled has no
 * persisted view — recovery projects its jsonl transcript into the snapshot
 * shape the GUI consumes. Two hard rules, both learned from real failures
 * (docs/review/0.5.1-defect-handoff.md P0-5):
 *
 * ① Record-family preservation. The transcript carries far more than
 *    `message` rows — custom / custom_message (advisor & hook cards),
 *    compaction, branch_summary, model_change, mode_change,
 *    thinking_level_change, title_change, label, reset_boundary … Dropping
 *    everything except `message` made compaction dividers, advisor cards and
 *    title slots vanish from the GUI for every recovered session, and broke
 *    "trajectory matches transcript" comparisons by construction.
 *
 * ② View-key rekeying. Transcript ids/parentIds live in the SDK hex tree
 *    space; the materialized view's identity space is messageKey("role:ts")
 *    for messages and "type:tsMs" for everything else. Passing hex ids
 *    through leaves id/parentId in a different key space from every other
 *    session, so branchChildren / breadcrumbs / leafPath lookups silently
 *    miss. Every entry is rekeyed here (collision-suffixed), and parentId
 *    remaps to the nearest MESSAGE ancestor's view id — non-message parents
 *    (model_change etc.) dangle for tree consumers otherwise. Note the
 *    remap resolves the ancestor's SUFFIXED view id, not a recomputed base
 *    key: same-millisecond same-role collisions would otherwise reparent the
 *    child onto the wrong duplicate.
 *
 * The 256-byte title slot (its own `{"type":"title"…}` line, padded) is not
 * a transcript entry — it is harvested into the snapshot header's title so
 * recovered sessions keep their display name.
 *
 * cursor is the caller's journal-seq tail, NOT an entry count: the GUI seeds
 * its M1.4 watermark from snapshot.cursor, and the journal numbers the next
 * live records — an entry-count cursor would drop every live record as a
 * "replay".
 */
import * as fs from "node:fs/promises";
import type { SessionEntry, SessionHeader, SessionState, WireMessage } from "@musepi/pi-wire";
import { messageKey, type Static, type sessionSnapshot } from "@musepi/sdk";

/** Session file title-slot line (SESSION_TITLE_SLOT_ENTRY_TYPE) — header
 *  metadata, not a transcript entry. */
interface TitleSlotRecord {
	type: "title";
	title?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Rekey every entry into the view identity space (see module header ②). */
function rekeyEntriesToViewSpace(entries: readonly SessionEntry[]): SessionEntry[] {
	const byHex = new Map<string, SessionEntry>();
	for (const e of entries) byHex.set(e.id, e);
	// Nearest MESSAGE ancestor's hex id — tree consumers link through
	// messages only; a non-message parent (model_change/custom) would
	// dangle for branchChildren/leafPath walks.
	const nearestMessageHexOf = (startId: string | null | undefined): string | null => {
		let cur = startId ? byHex.get(startId) : undefined;
		const seen = new Set<string>();
		while (cur && !seen.has(cur.id)) {
			seen.add(cur.id);
			if (cur.type === "message" && (cur as { message?: unknown }).message) return cur.id;
			cur = cur.parentId ? byHex.get(cur.parentId) : undefined;
		}
		return null;
	};
	const usedViewIds = new Set<string>();
	const viewIdByHex = new Map<string, string>();
	for (const e of entries) {
		const msg = (e as { message?: unknown }).message;
		let base: string;
		if (e.type === "message" && isRecord(msg)) {
			base = messageKey(msg as unknown as WireMessage);
		} else {
			const tsMs = Date.parse(e.timestamp);
			base = Number.isFinite(tsMs) ? `${e.type}:${tsMs}` : e.id;
		}
		let viewId = base;
		for (let n = 2; usedViewIds.has(viewId); n++) viewId = `${base}#${n}`;
		usedViewIds.add(viewId);
		viewIdByHex.set(e.id, viewId);
	}
	return entries.map(e => ({
		...e,
		id: viewIdByHex.get(e.id) ?? e.id,
		parentId: nearestMessageHexOf(e.parentId)
			? (viewIdByHex.get(nearestMessageHexOf(e.parentId) as string) ?? null)
			: null,
	}));
}

/**
 * Project an SDK transcript (jsonl of final entries, `session` header line,
 * optional leading `title` slot line) into the session-snapshot shape.
 *
 * @param cursor journal-seq tail — becomes the snapshot cursor (the GUI's
 *   initial watermark). Never an entry count.
 */
export async function snapshotFromJsonl(
	file: string,
	sessionId: string,
	cursor: number,
): Promise<Static<typeof sessionSnapshot>> {
	const text = await fs.readFile(file, "utf8");
	const records: Record<string, unknown>[] = [];
	let header: SessionHeader | undefined;
	let titleFromSlot: string | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (rec.type === "session") {
			header = rec as unknown as SessionHeader;
			continue;
		}
		if (rec.type === "title") {
			const t = (rec as unknown as TitleSlotRecord).title;
			if (typeof t === "string" && t) titleFromSlot = t;
			continue;
		}
		if (typeof rec.type !== "string") continue;
		records.push(rec);
	}

	// Normalize every surviving record into a SessionEntry. Unknown future
	// types pass through untouched (forward compat) — only the base contract
	// (id/parentId/timestamp present and correctly typed) is enforced.
	const entries: SessionEntry[] = records.map((rec, i) => {
		const id = typeof rec.id === "string" ? rec.id : `${String(rec.type)}-${i}`;
		const parentId = typeof rec.parentId === "string" ? rec.parentId : null;
		const message = (rec as { message?: unknown }).message;
		const timestamp =
			typeof rec.timestamp === "string"
				? rec.timestamp
				: isRecord(message) && typeof message.timestamp === "number"
					? new Date(message.timestamp).toISOString()
					: "";
		return { ...rec, id, parentId, timestamp } as unknown as SessionEntry;
	});
	const viewEntries = rekeyEntriesToViewSpace(entries);

	const cwd = header && typeof header.cwd === "string" ? header.cwd : "";
	const state: SessionState = {
		isStreaming: false,
		queuedMessageCount: 0,
		cwd,
		participants: [],
	};
	const baseHeader = header ?? { type: "session" as const, id: sessionId, timestamp: "", cwd };
	return {
		header:
			titleFromSlot && typeof (baseHeader as { title?: unknown }).title !== "string"
				? ({ ...baseHeader, title: titleFromSlot } as SessionHeader)
				: baseHeader,
		entries: viewEntries,
		state,
		agents: [],
		cursor,
	};
}
