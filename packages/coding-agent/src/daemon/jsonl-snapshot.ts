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
 *    maps to the DIRECT hex parent's view id (resolved through the same
 *    suffixed map, never a recomputed base key: same-millisecond same-role
 *    collisions would otherwise reparent the child onto the wrong
 *    duplicate). Remapping through the nearest MESSAGE ancestor instead is
 *    wrong: it drops advisor/custom/thinking_level_change nodes off parent
 *    chains, so the post-advisor assistant reparented under the pre-advisor
 *    one and the advisor card plus the next user message rendered as phantom
 *    sibling branches "3-1/3-2" on two map lanes (real session 01a13e95).
 *    Chain fidelity first — message-only tree consumers walk up through
 *    non-message nodes themselves.
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

/** Rekey every entry into the view identity space (see module header ②).
 *  Shared with the daemon resume-seed path (session-host adoptAgentSession)
 *  — one implementation so history resume and transcript recovery project
 *  identical chains. */
export function rekeyEntriesToViewSpace(entries: readonly SessionEntry[]): SessionEntry[] {
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
		// Direct hex-parent mapping: every entry was rekeyed above, so the
		// parent always resolves in-snapshot (unknown hex maps to null, same
		// as a genuine root). Never skip non-message nodes — see header note.
		parentId: typeof e.parentId === "string" ? (viewIdByHex.get(e.parentId) ?? null) : null,
	}));
}

/**
 * Newest entry timestamp (epoch ms) of an SDK transcript, read from the
 * tail only — the history-resume path uses it to tell a journal that
 * missed records apart from an authoritative one (see session-host
 * `snapshot()`). Returns null when the file is missing, unreadable, or
 * carries no parseable timestamp. Never throws.
 */
export async function readSdkNewestTimestamp(file: string): Promise<number | null> {
	let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
	try {
		handle = await fs.open(file, "r");
		const { size } = await handle.stat();
		if (size <= 0) return null;
		const take = Math.min(size, 4096);
		const buf = Buffer.alloc(take);
		await handle.read(buf, 0, take, size - take);
		const lines = buf.toString("utf8").split("\n");
		// The chunk may start mid-record and end with a torn line: only trust
		// complete lines (a trailing fragment without "\n" at EOF is skipped).
		const complete = buf[take - 1] === 0x0a ? lines : lines.slice(0, -1);
		for (let i = complete.length - 1; i >= 0; i--) {
			const line = complete[i]?.trim();
			if (!line) continue;
			try {
				const rec = JSON.parse(line) as { timestamp?: unknown };
				if (typeof rec.timestamp === "string") {
					const ms = Date.parse(rec.timestamp);
					if (Number.isFinite(ms)) return ms;
				}
			} catch {}
		}
		return null;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => {});
	}
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
