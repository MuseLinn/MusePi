/**
 * Append-only session journal — the event-sourcing store for the daemon
 * (daemon Phase 3).
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

/** session.catchup verdict (M1.4) — pure guard over (checkpoint, tail,
 *  afterSeq) so the contract is testable without a daemon host:
 *
 * - afterSeq < checkpointSeq → resyncRequired: the missing records were
 *   folded into the checkpoint snapshot, replay cannot reconstruct them
 *   (`compactedThrough` = checkpoint seq).
 * - afterSeq > tailSeq → resyncRequired: the watermark comes from a
 *   divergent journal; replaying nothing would strand it above every
 *   future seq (its gate would skip real events).
 * - otherwise the journal holds every record in (afterSeq, tail] and the
 *   caller replays them in order. */
export function catchupPlan(
	afterSeq: number,
	checkpointSeq: number,
	tailSeq: number,
): { resyncRequired: true; compactedThrough: number } | { resyncRequired: false } {
	if (afterSeq < checkpointSeq) return { resyncRequired: true, compactedThrough: checkpointSeq };
	if (afterSeq > tailSeq) return { resyncRequired: true, compactedThrough: checkpointSeq };
	return { resyncRequired: false };
}

/**
 * Per-file exclusive queue for the rewrite operations (compact). Each
 * writes a fixed `<file>.tmp` then renames it — two rewrites of the same
 * journal racing delete each other's .tmp and the loser crashes with
 * ENOENT. Appends are chained per instance already; rewrites go through
 * this module-level queue so different
 * AppendJournal instances for the same session serialize too.
 */
/** Tail-read chunk for {@link AppendJournal.readTailSeq}: covers thousands of
 *  records while keeping session.history-style watermark stamps off the full
 *  journal scan. */
const TAIL_SEQ_READ_BYTES = 64 * 1024;

const rewriteLocks = new Map<string, Promise<void>>();
function withRewriteLock(filePath: string, fn: () => Promise<void>): Promise<void> {
	const prev = rewriteLocks.get(filePath) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	rewriteLocks.set(
		filePath,
		next.catch(() => {
			// keep the chain alive for the next caller
		}),
	);
	return next;
}

/**
 * Rename error codes worth retrying. On Windows, renaming over a file held
 * open by another handle (or transiently scanned by AV/Defender) fails with
 * EPERM/EACCES/EBUSY; on POSIX those codes are real permission errors and
 * only EBUSY is transient. Mirrors proma's fs-retry platform split.
 */
const RETRYABLE_RENAME_CODES = new Set(process.platform === "win32" ? ["EPERM", "EACCES", "EBUSY"] : ["EBUSY"]);

/**
 * Per-file live fd registry. Several AppendJournal instances can hold the
 * same journal file open (the live session's journal + a transient
 * A rewrite must close EVERY instance's fd
 * before renaming over the file — Windows rejects the rename while ANY
 * handle holds the target — then let each instance reopen its own.
 */
const fdRegistry = new Map<string, Set<AppendJournal>>();
function withFd(filePath: string): Set<AppendJournal> {
	let set = fdRegistry.get(filePath);
	if (!set) {
		set = new Set();
		fdRegistry.set(filePath, set);
	}
	return set;
}

/**
 * Coordination helper: ask every instance on `filePath` to release its fd
 * (private-field access stays inside the class). Callers invoke
 * AppendJournal#releaseFd / #reopenFd directly; this just fans out.
 */
function forEachFdInstance(filePath: string, fn: (inst: AppendJournal) => Promise<void>): Promise<void> {
	return Promise.all([...(fdRegistry.get(filePath) ?? [])].map(fn)).then(() => {});
}

export class AppendJournal {
	readonly filePath: string;
	#fd: fs.promises.FileHandle | null = null;
	/** Resolves to the current append fd once open (re-resolved after a
	 *  rewrite's close→rename→reopen). Appends chain on this so a write
	 *  landing in the rewrite window is queued, not silently dropped. */
	#fdReady: Promise<fs.promises.FileHandle | null> = Promise.resolve(null);
	#seq = 0;
	/** Records appended since the last compact — the event-count compaction
	 *  bound. The persistent #seq must NOT be the threshold basis: right after
	 *  a restart it is large from the recovered tail while the file itself is
	 *  small. */
	#appendedSinceCompact = 0;

	constructor(dir: string, sessionId: string) {
		this.filePath = path.join(dir, `${sessionId}.journal.jsonl`);
	}

	async open(): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
		this.#fd = await fs.promises.open(this.filePath, "a");
		withFd(this.filePath).add(this);
		this.#fdReady = Promise.resolve(this.#fd);
		// Seq persistence: a reopened journal (daemon restart, transient
		// history read) continues where the file's tail left off. Renumbering
		// from 0 would collide with records already on disk and break every
		// downstream consumer that treats seq as a watermark (catchup, client
		// gap gate). Fresh/empty files read a 0 tail and keep the 1-based
		// numbering.
		this.#seq = await AppendJournal.readTailSeq(this.filePath);
		this.#appendedSinceCompact = 0;
	}

	/** Seq of the last valid record in a journal file (0 when the file is
	 *  missing or has no parseable record). Reads only the trailing bytes —
	 *  watermark stamps must not pay a full journal scan. Tolerates a torn
	 *  tail line and bad lines: scans backward for the last parseable one.
	 *  Oversized single records (one line over the chunk) fall back to a
	 *  whole-file scan so the tail is never misreported as 0. */
	static async readTailSeq(filePath: string): Promise<number> {
		let handle: fs.promises.FileHandle | null = null;
		try {
			handle = await fs.promises.open(filePath, "r");
			const fd = handle;
			const { size } = await fd.stat();
			const scan = async (from: number, length: number): Promise<number> => {
				const buf = Buffer.alloc(length);
				await fd.read(buf, 0, length, from);
				const lines = buf.toString("utf8").split("\n");
				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i].trim();
					if (!line) continue;
					try {
						const parsed = JSON.parse(line) as { seq?: unknown };
						if (typeof parsed.seq === "number" && Number.isInteger(parsed.seq)) return parsed.seq;
					} catch {
						// torn/invalid line — keep scanning backward
					}
				}
				return -1;
			};
			const chunk = Math.min(size, TAIL_SEQ_READ_BYTES);
			const found = await scan(size - chunk, chunk);
			if (found >= 0) return found;
			if (size > chunk) return Math.max(await scan(0, size), 0);
			return 0;
		} catch {
			return 0; // missing/unreadable file
		} finally {
			await handle?.close().catch(() => {});
		}
	}

	/** Current tail seq (last assigned). The next append is tailSeq + 1. */
	get tailSeq(): number {
		return this.#seq;
	}

	/** Append a wire event; returns its journal seq. Shrinks payloads so a
	 * single oversized event can never poison replay (same cap as collab). */
	append(event: WireAgentEvent): number {
		const seq = ++this.#seq;
		this.#appendedSinceCompact += 1;
		const record: JournalRecord = { seq, ts: new Date().toISOString(), event: shrinkForReplication(event) };
		const line = `${JSON.stringify(record)}\n`;
		this.#writtenBytes += line.length;
		// Writes are queued on a chain: fire-and-forget at the call site,
		// but every reader (readAll/compact/close) flushes first so a
		// high-frequency event burst can never lose its tail. The chain
		// awaits #fdReady so an append landing during a rewrite's
		// close→rename→reopen window is written to the reopened fd.
		// EBADF is tolerated: a cross-instance rewrite (forEachFdInstance
		// closing every fd on the file) can close this instance's fd after
		// the captured handle was resolved from #fdReady but before the
		// actual write — the event is lost but the journal stays operational.
		const prev = this.#pendingWrite ?? Promise.resolve();
		this.#pendingWrite = prev
			.then(() => this.#fdReady)
			.then(fd => {
				if (!fd) return;
				return fd.write(line).catch((err: unknown) => {
					if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EBADF") return;
					throw err;
				});
			})
			.then(() => {});
		return seq;
	}

	/** Wait for all queued appends to reach the OS. */
	async flush(): Promise<void> {
		await this.#pendingWrite;
	}

	/** Records with seq > afterSeq, in journal order — the session.catchup
	 *  replay contract (M1.4): a gap fill must arrive strictly in the
	 *  journal numbering the client's watermark gate compares against. */
	async recordsAfter(afterSeq: number): Promise<JournalRecord[]> {
		await this.flush();
		const out: JournalRecord[] = [];
		for (const record of await this.readAll()) {
			if (record.seq > afterSeq) out.push(record);
		}
		return out;
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
		await withRewriteLock(this.filePath, async () => {
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
			await this.#replaceFile(tmpJournal);
			this.#writtenBytes = keep.reduce((acc, r) => acc + JSON.stringify(r).length, 0);
			this.#appendedSinceCompact = 0;
		});
	}

	/** Should the journal be compacted? (records appended since the last
	 *  compact, or bytes written this process) */
	async shouldCompact(): Promise<boolean> {
		if (this.#appendedSinceCompact >= COMPACT_EVENT_THRESHOLD) return true;
		if (this.#writtenBytes >= COMPACT_BYTE_THRESHOLD) return true;
		return false;
	}

	/** Release this instance's append fd (rewrite coordination). */
	async #releaseFd(): Promise<void> {
		if (this.#fd !== null) {
			await this.flush();
			await this.#fd.close();
			this.#fd = null;
		}
		this.#fdReady = new Promise(() => {});
	}

	/** Reopen this instance's append fd after a rewrite (idempotent). */
	async #reopenFd(): Promise<void> {
		if (this.#fd !== null) return;
		try {
			this.#fd = await fs.promises.open(this.filePath, "a");
		} catch {
			this.#fd = null;
		}
		this.#fdReady = Promise.resolve(this.#fd);
	}

	/**
	 * Windows-safe atomic journal replacement. POSIX allows rename-over-open
	 * but leaves a stale fd pointing at the unlinked inode — later appends
	 * would silently vanish; Windows rejects the rename with EPERM while ANY
	 * handle (including another AppendJournal instance's) holds the target.
	 * Both platforms need the same sequence: close every fd on the file,
	 * rename (bounded retry for transient locks), reopen each fd.
	 */
	async #replaceFile(tmpPath: string): Promise<void> {
		await this.flush();
		// Close every instance's fd (the live session's journal may be a
		// DIFFERENT instance than the one running this rewrite).
		await forEachFdInstance(this.filePath, inst => inst.#releaseFd());
		let lastErr: unknown;
		try {
			for (let attempt = 1; ; attempt++) {
				try {
					await fs.promises.rename(tmpPath, this.filePath);
					break;
				} catch (err) {
					lastErr = err;
					const code = (err as NodeJS.ErrnoException)?.code;
					if (!code || !RETRYABLE_RENAME_CODES.has(code) || attempt >= 4) throw err;
					await new Promise(r => setTimeout(r, 50 * 2 ** (attempt - 1)));
				}
			}
		} finally {
			// Reopen every closed instance regardless of rename outcome so
			// the journal stays appendable; a failed reopen keeps fd null
			// (append skips, same as pre-open).
			await forEachFdInstance(this.filePath, inst => inst.#reopenFd());
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
		withFd(this.filePath).delete(this);
		if (this.#fd !== null) {
			await this.flush();
			await this.#fd.close();
			this.#fd = null;
		}
		this.#fdReady = Promise.resolve(null);
	}
}
