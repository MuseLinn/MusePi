// ============================================================
// MusePi transcript — store (L1/L2 assembled).
//
// Holds the transcript, maintains per-turn aggregates, and offers
// turn-cursor pagination for views. rebuild() replays the full entry
// list (cheap enough for interactive use); sync() appends only new
// entries for live sessions.
// ============================================================

import { applyEntry, replayEntries } from "./ops.ts";
import { emptyTranscript, type Transcript, type TranscriptTurn } from "./model.ts";

interface EntryLike {
	type: string;
	id: string;
	timestamp: string;
	message?: { role: string; content?: string | Array<unknown> };
	customType?: string;
	display?: boolean;
}

function recomputeAggregates(turn: TranscriptTurn): void {
	let toolCalls = 0;
	let hasError = false;
	for (const i of turn.interactions) {
		if (i.kind === "tool_call") toolCalls++;
		if (i.kind === "tool_result" && i.isError) hasError = true;
	}
	turn.toolCalls = toolCalls;
	turn.hasError = hasError;
}

export class TranscriptStore {
	private transcript: Transcript = emptyTranscript();
	private syncedIds = new Set<string>();

	/** Full replay from session entries (idempotent — safe to call twice). */
	rebuild(entries: readonly EntryLike[]): Transcript {
		this.transcript = replayEntries(entries);
		this.syncedIds = new Set(entries.map((e) => e.id));
		for (const turn of this.transcript.turns) recomputeAggregates(turn);
		return this.transcript;
	}

	/** Incremental sync for live sessions: apply only unseen entries. */
	sync(entries: readonly EntryLike[]): number {
		let added = 0;
		for (const e of entries) {
			if (this.syncedIds.has(e.id)) continue;
			this.syncedIds.add(e.id);
			applyEntry(this.transcript, e);
			added++;
		}
		for (const turn of this.transcript.turns) recomputeAggregates(turn);
		return added;
	}

	get turns(): readonly TranscriptTurn[] {
		return this.transcript.turns;
	}

	get entryCount(): number {
		return this.syncedIds.size;
	}

	/** Turn-cursor pagination: newest-first pages. */
	page(opts: { beforeTurn?: number; limit: number }): { turns: TranscriptTurn[]; nextBefore?: number } {
		const all = this.transcript.turns;
		const end = opts.beforeTurn === undefined ? all.length : Math.min(opts.beforeTurn, all.length);
		const start = Math.max(0, end - opts.limit);
		return {
			turns: all.slice(start, end),
			nextBefore: start > 0 ? start : undefined,
		};
	}

	stats(): { turns: number; entries: number; toolCalls: number; errorTurns: number } {
		let toolCalls = 0;
		let errorTurns = 0;
		for (const t of this.transcript.turns) {
			toolCalls += t.toolCalls;
			if (t.hasError) errorTurns++;
		}
		return { turns: this.transcript.turns.length, entries: this.syncedIds.size, toolCalls, errorTurns };
	}
}
