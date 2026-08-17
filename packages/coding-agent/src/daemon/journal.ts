/**
 * Append-only session journal — the event-sourcing store for the daemon
 * (gui-architecture Phase 3).
 *
 * Format: one JSON line per record, `{ seq, ts, event }`, where `event` is a
 * **wire-compatible** AgentEvent (guarded by `isWireAgentEvent`). Recording
 * wire events from day one means the journal, the live stream and the SDK
 * contract stay on a single format — replay and the future materialized view
 * never need a dual-format compatibility layer.
 *
 * Lifecycle: the journal is opened per live session, appended to on every
 * wire event, and closed on dispose. Replay (`readAll`) returns records in
 * seq order; it does not reconstruct a *running* agent (that state lives in
 * memory) — it feeds resume initial events and future materialized views.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent as WireAgentEvent } from "@musepi/pi-wire";
import { shrinkForReplication } from "../collab/replication-shrink";

export interface JournalRecord {
	seq: number;
	ts: string;
	event: WireAgentEvent;
}

/** Compacted checkpoint: the materialized snapshot at a given seq. Events
 *  at or below `seq` were folded into `snapshot` and removed from the
 *  journal; replay = checkpoint + journal increments above `seq`. */
export interface JournalCheckpoint {
	seq: number;
	ts: string;
	snapshot: unknown;
}

/** Compaction triggers: fold when the journal passes either bound. */
export const COMPACT_EVENT_THRESHOLD = 2000;
export const COMPACT_BYTE_THRESHOLD = 4 * 1024 * 1024;

export class AppendJournal {
	readonly filePath: string;
	#fd: fs.promises.FileHandle | null = null;
	#seq = 0;

	constructor(dir: string, sessionId: string) {
		this.filePath = path.join(dir, `${sessionId}.journal.jsonl`);
	}

	async open(): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
		this.#fd = await fs.promises.open(this.filePath, "a");
	}

	/** Append a wire event; returns its journal seq. Shrinks payloads so a
	 * single oversized event can never poison replay (same cap as collab). */
	append(event: WireAgentEvent): number {
		const seq = ++this.#seq;
		const record: JournalRecord = { seq, ts: new Date().toISOString(), event: shrinkForReplication(event) };
		if (this.#fd !== null) {
			const line = `${JSON.stringify(record)}\n`;
			this.#writtenBytes += line.length;
			// Writes are queued on a chain: fire-and-forget at the call site,
			// but every reader (readAll/compact/close) flushes first so a
			// high-frequency event burst can never lose its tail.
			const prev = this.#pendingWrite ?? Promise.resolve();
			this.#pendingWrite = prev.then(() => this.#fd!.write(line)).then(() => {});
		}
		return seq;
	}

	/** Wait for all queued appends to reach the OS. */
	async flush(): Promise<void> {
		await this.#pendingWrite;
	}

	/** All records in seq order (used for resume initial replay). */
	async readAll(): Promise<JournalRecord[]> {
		await this.flush();
		let text: string;
		try {
			text = await fs.promises.readFile(this.filePath, "utf8");
		} catch {
			return [];
		}
		const records: JournalRecord[] = [];
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line) as JournalRecord);
			} catch {
				// tail-crash partial line: stop, the rest is unrecoverable
				break;
			}
		}
		return records;
	}

	checkpointPath(): string {
		return `${this.filePath}.checkpoint.json`;
	}

	/** Read the checkpoint (null when never compacted). */
	static async readCheckpoint(filePath: string): Promise<JournalCheckpoint | null> {
		try {
			const raw = await fs.promises.readFile(`${filePath}.checkpoint.json`, "utf8");
			const parsed = JSON.parse(raw) as JournalCheckpoint;
			if (typeof parsed.seq !== "number" || parsed.snapshot === undefined) return null;
			return parsed;
		} catch {
			return null;
		}
	}

	/** Bytes written so far this process (for the byte threshold). */
	#writtenBytes = 0;
	/** Chain of pending writes — readAll/compact/close flush before reading. */
	#pendingWrite: Promise<void> | null = null;

	/**
	 * Compact: atomically write the checkpoint (folded snapshot at
	 * `checkpointSeq`), then rewrite the journal to keep only events with
	 * seq > checkpointSeq. Ordering makes a mid-sequence crash safe: a
	 * written checkpoint with an untrimmed journal replays as checkpoint +
	 * ALL events, where applies at or below the checkpoint seq are no-ops
	 * for the view (its seq guard is monotonic) — see replay path.
	 */
	async compact(checkpointSeq: number, snapshot: unknown): Promise<void> {
		await this.flush();
		const ckpt: JournalCheckpoint = { seq: checkpointSeq, ts: new Date().toISOString(), snapshot };
		const tmpCkpt = `${this.checkpointPath()}.tmp`;
		await fs.promises.writeFile(tmpCkpt, JSON.stringify(ckpt), "utf8");
		await fs.promises.rename(tmpCkpt, this.checkpointPath());

		const keep: JournalRecord[] = [];
		for (const record of await this.readAll()) {
			if (record.seq > checkpointSeq) keep.push(record);
		}
		const tmpJournal = `${this.filePath}.tmp`;
		await fs.promises.writeFile(
			tmpJournal,
			keep.map(r => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""),
			"utf8",
		);
		await fs.promises.rename(tmpJournal, this.filePath);
		this.#writtenBytes = keep.reduce((acc, r) => acc + JSON.stringify(r).length, 0);
	}

	/** Should the journal be compacted? (event count or byte size bound) */
	async shouldCompact(): Promise<boolean> {
		if (this.#seq >= COMPACT_EVENT_THRESHOLD) return true;
		if (this.#writtenBytes >= COMPACT_BYTE_THRESHOLD) return true;
		return false;
	}

	/**
	 * Rewrite the checkpoint with a replacement snapshot (compact-mode
	 * revert: the truncated snapshot is folded back into the checkpoint and
	 * the journal is emptied — every surviving record is <= the checkpoint
	 * seq, so replay is checkpoint-only).
	 */
	async replaceCheckpoint(snapshot: unknown, seq: number): Promise<void> {
		await this.flush();
		const ckpt: JournalCheckpoint = { seq, ts: new Date().toISOString(), snapshot };
		const tmpCkpt = `${this.checkpointPath()}.tmp`;
		await fs.promises.writeFile(tmpCkpt, JSON.stringify(ckpt), "utf8");
		await fs.promises.rename(tmpCkpt, this.checkpointPath());
		const tmpJournal = `${this.filePath}.tmp`;
		await fs.promises.writeFile(tmpJournal, "", "utf8");
		await fs.promises.rename(tmpJournal, this.filePath);
		this.#writtenBytes = 0;
	}

	/**
	 * Truncate: rewrite the journal keeping only records with seq <=
	 * targetSeq and DROP the checkpoint (its folded snapshot may contain
	 * truncated events — a stale checkpoint would resurrect them). Used by
	 * session.revertTo (message undo / edit-and-reconverse).
	 */
	async truncate(targetSeq: number): Promise<void> {
		await this.flush();
		const keep: JournalRecord[] = [];
		for (const record of await this.readAll()) {
			if (record.seq <= targetSeq) keep.push(record);
		}
		const tmpJournal = `${this.filePath}.tmp`;
		await fs.promises.writeFile(
			tmpJournal,
			keep.map(r => JSON.stringify(r)).join("\n") + (keep.length ? "\n" : ""),
			"utf8",
		);
		await fs.promises.rename(tmpJournal, this.filePath);
		this.#writtenBytes = keep.reduce((acc, r) => acc + JSON.stringify(r).length, 0);
		try {
			await fs.promises.unlink(this.checkpointPath());
		} catch {
			// no checkpoint — nothing to drop
		}
	}

	/** Replay source: checkpoint + journal increments. Returns the checkpoint
	 *  (or null) and the events to apply AFTER it. Callers reconstruct via
	 *  MaterializedView.fromSnapshot + apply. */
	async replaySource(): Promise<{ checkpoint: JournalCheckpoint | null; events: WireAgentEvent[] }> {
		const checkpoint = await AppendJournal.readCheckpoint(this.filePath);
		const events: WireAgentEvent[] = [];
		for (const record of await this.readAll()) {
			if (checkpoint && record.seq <= checkpoint.seq) continue;
			events.push(record.event);
		}
		return { checkpoint, events };
	}

	async close(): Promise<void> {
		if (this.#fd !== null) {
			await this.flush();
			await this.#fd.close();
			this.#fd = null;
		}
	}
}
