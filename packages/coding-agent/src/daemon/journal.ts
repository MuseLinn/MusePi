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

/**
 * Byte offset and seq of every record line in a window, keyed to where that
 * window began.
 *
 * `base` is what makes a window indistinguishable from a whole file: the
 * offsets are absolute, so a caller comparing one against a file position does
 * not have to know the text it was handed started somewhere other than zero.
 */
interface LineIndex {
	/** Absolute offset of the text the offsets are measured from. */
	readonly base: number;
	readonly offsets: number[];
	readonly seqs: number[];
	readonly bytes: number;
}

/**
 * Bytes a tail scan reads per step while growing a window back from the end.
 *
 * 64 KiB holds a few hundred typical records, so the common case — a client
 * reconnecting after a few seconds — is a single read, and a wide gap costs
 * four reads rather than thousands of small ones.
 */
const TAIL_SCAN_CHUNK = 64 * 1024;

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
	/** Memoized teardown — see close(). */
	#closePromise: Promise<void> | null = null;
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
		// The index is a view of the file's current bytes; an append invalidates
		// it, and the next read rebuilds it from the longer text.
		this.#lineIndexCache = null;
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
	 *  journal numbering the client's watermark gate compares against.
	 *
	 *  Reads the tail of the journal rather than the whole file. A reconnect
	 *  asks for the records after a cursor, and a journal only grows at the end,
	 *  so those records are at the end — and on a journal at the
	 *  byte-compaction threshold, opening the whole file to find them costs
	 *  more than parsing them does. The read is what dominates; the parse is
	 *  what this also avoids.
	 *
	 *  The cost tracks the gap rather than the age of the session: a client that
	 *  missed one event reads a chunk, and a client that missed a thousand reads
	 *  about what a thousand events weigh. A cursor below everything the file
	 *  holds — a first connection, or one that has been compacted away — reads
	 *  the whole file, because that is what was asked for. */
	async recordsAfter(afterSeq: number): Promise<JournalRecord[]> {
		const window = await this.#tailWindow(afterSeq);
		this.lastBytesRead = window.bytesRead;
		const text = window.text;
		const out: JournalRecord[] = [];
		if (text === null || text.length === 0) {
			this.lastParseCount = 0;
			return out;
		}

		// The window starts at a record at or below the cursor (or at the file's
		// first record, when the cursor predates it), so the first line whose seq
		// passes the cursor is where the replay begins.
		const index = this.#lineIndex(text, window.startByte);
		let startByte = -1;
		for (let i = 0; i < index.seqs.length; i++) {
			if ((index.seqs[i] as number) > afterSeq) {
				startByte = index.offsets[i] as number;
				break;
			}
		}
		// Everything in the window is at or below the cursor: nothing to deliver.
		if (startByte === -1) {
			this.lastParseCount = 0;
			return out;
		}

		let lineStart = startByte - window.startByte;
		let delivered = 0;
		while (lineStart < text.length) {
			const newline = text.indexOf("\n", lineStart);
			const lineEnd = newline === -1 ? text.length : newline;
			if (lineEnd > lineStart) {
				const line = text.slice(lineStart, lineEnd).trim();
				if (line) {
					try {
						const record = JSON.parse(line) as JournalRecord;
						if (record.seq > afterSeq) {
							out.push(record);
							delivered++;
						}
					} catch {
						// A partial tail line: stop, exactly as `readAll` does.
						// Continuing would splice a truncated record into a replay.
						break;
					}
				}
			}
			if (newline === -1) break;
			lineStart = newline + 1;
		}
		this.lastParseCount = delivered;
		return out;
	}

	/**
	 * Byte offset and seq of every record line in `text`, or the cached copy.
	 *
	 * Building it costs one pass that reads each line's head and nothing else —
	 * no JSON.parse, no record allocated. Cached per (base offset, length), so a
	 * second catch-up whose window lands on the same bytes pays nothing.
	 *
	 * Invalidated by anything that can move a line: an append, a compaction
	 * rewrite, and a cross-instance rewrite that replaces the file under a held
	 * fd.
	 */
	#lineIndexCache: LineIndex | null = null;

	#lineIndex(text: string, base: number): LineIndex {
		const cached = this.#lineIndexCache;
		if (cached !== null && cached.base === base && cached.bytes === text.length) return cached;
		const offsets: number[] = [];
		const seqs: number[] = [];
		let lineStart = 0;
		while (lineStart < text.length) {
			const newline = text.indexOf("\n", lineStart);
			// A trailing run with no newline is a partial append: it is not a
			// record yet, so the index stops before it, and `readAll` stops there
			// too — the two agree on where the records end.
			if (newline === -1) break;
			if (newline > lineStart) {
				const seq = this.#seqFromLine(text, lineStart, newline);
				if (seq === null) break;
				offsets.push(base + lineStart);
				seqs.push(seq);
			}
			lineStart = newline + 1;
		}
		this.#lineIndexCache = { base, offsets, seqs, bytes: text.length };
		return this.#lineIndexCache;
	}

	/**
	 * The tail of the journal, far enough back to hold the cursor.
	 *
	 * Grows a window back from the end of the last complete line until it
	 * contains a record whose seq is at or below `afterSeq`, then returns that
	 * window's text together with the absolute byte offset it starts at — so a
	 * window is indistinguishable from a whole file to everything downstream.
	 *
	 * Growing by four rather than stepping in fixed chunks because a gap and a
	 * record's size vary by orders of magnitude: a fixed step either stops short
	 * on a wide gap or walks the whole file for a narrow one. The first window
	 * holds a few hundred typical records, so the common case — a client
	 * reconnecting after a moment — is one read.
	 *
	 * Returns `text: null` for a journal that is missing, empty, or holds no
	 * complete line. Falls back to the whole file in two cases: a cursor below
	 * the first record (a compacted or restarted journal), and a scan that grew
	 * all the way to the start without meeting it.
	 */
	async #tailWindow(afterSeq: number): Promise<{ text: string | null; startByte: number; bytesRead: number }> {
		await this.flush();
		const handle = await fs.promises.open(this.filePath, "r").catch(() => null);
		if (!handle) {
			// The file went away between the flush and the open — a compaction
			// rewrite from another instance. Reading whatever is there now is the
			// honest answer; there is no file left to take a tail of.
			const text = await this.#readText();
			return { text, startByte: 0, bytesRead: text.length };
		}
		try {
			const completeEnd = await this.#lastCompleteLineEnd(handle);
			if (completeEnd === 0) return { text: null, startByte: 0, bytesRead: 0 };

			let window = TAIL_SCAN_CHUNK;
			let from = Math.max(0, completeEnd - window);
			let found = -1;
			for (;;) {
				const want = completeEnd - from;
				const buf = Buffer.allocUnsafe(want);
				await handle.read(buf, 0, want, from);
				const chunk = buf.toString("utf8");
				const lines = chunk.split("\n");
				// Line 0 starts mid-record unless this window is the whole file,
				// and a record whose head is missing cannot be recognised, so it
				// is only trusted when nothing precedes it.
				const firstUsable = from > 0 ? 1 : 0;
				let offset = 0;
				for (let i = 0; i < firstUsable; i++) offset += (lines[i] as string).length + 1;
				for (let i = firstUsable; i < lines.length; i++) {
					const line = lines[i] as string;
					const seq = this.#seqFromLine(line, 0, line.length);
					if (seq !== null && seq <= afterSeq) {
						found = from + offset;
						break;
					}
					offset += line.length + 1;
				}
				if (found !== -1) break;
				if (from === 0) break;
				window *= 4;
				from = Math.max(0, completeEnd - window);
			}

			const start = found === -1 ? 0 : found;
			const want = completeEnd - start;
			const buf = Buffer.allocUnsafe(want);
			await handle.read(buf, 0, want, start);
			return { text: buf.toString("utf8"), startByte: start, bytesRead: want };
		} finally {
			await handle.close();
		}
	}

	/**
	 * Byte offset just past the journal's last newline.
	 *
	 * Everything after it is an append that has not finished, and starting a
	 * replay there would hand back a truncated record. Found by walking the tail
	 * a chunk at a time rather than from one fixed window, because a single
	 * record can be larger than any window worth allocating and the boundary is
	 * then the newline before it — however far back that is.
	 */
	async #lastCompleteLineEnd(handle: fs.promises.FileHandle): Promise<number> {
		const { size } = await handle.stat();
		let end = size;
		while (end > 0) {
			const want = Math.min(TAIL_SCAN_CHUNK, end);
			const start = end - want;
			const buf = Buffer.allocUnsafe(want);
			await handle.read(buf, 0, want, start);
			const newline = buf.subarray(0, want).toString("utf8").lastIndexOf("\n");
			if (newline !== -1) return start + newline + 1;
			end = start;
		}
		return 0;
	}

	/**
	 * The seq on the line spanning `[start, end)`, read from its head.
	 *
	 * A record is written as `{"seq":N,"ts":…,"event":…}` — seq first, so the
	 * number is within the first bytes of every line and finding it does not
	 * need the record parsed. Returns null for a line whose head carries no
	 * seq, which is how a partial append at the tail is told apart from a
	 * record.
	 */
	#seqFromLine(text: string, start: number, end: number): number | null {
		const head = text.slice(start, Math.min(end, start + 64));
		const match = /^\{"seq":(\d+),/.exec(head);
		return match?.[1] === undefined ? null : Number(match[1]);
	}

	/** Read the journal file as text, flushing first so the tail is included. */
	async #readText(): Promise<string> {
		await this.flush();
		try {
			return await fs.promises.readFile(this.filePath, "utf8");
		} catch {
			return "";
		}
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

	/**
	 * Records parsed by the last `recordsAfter` call, for instrumentation.
	 *
	 * Exposed so a caller — and a test — can assert what a read *parsed* rather
	 * than how long it took: a duration assertion is a coin flip on a loaded
	 * machine, while "it parsed the tail and not the whole file" is a fact
	 * about the code. Not part of the replay contract; nothing branches on it.
	 */
	lastParseCount = 0;

	/**
	 * Bytes the last `recordsAfter` read, for instrumentation.
	 *
	 * The number that says whether the tail scan is doing its job: a catch-up
	 * delivering ten records should read a fraction of a multi-megabyte journal,
	 * and one that reads all of it is back to paying per reconnect.
	 */
	lastBytesRead = 0;

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
			// The rewrite replaced the file: every offset in the cached index
			// now points into a file that no longer exists.
			this.#lineIndexCache = null;
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

	/**
	 * Release the append fd. Idempotent AND concurrency-safe: session
	 * teardown fires this without awaiting it, so a caller that must delete
	 * the journal file afterwards calls it again. Without the memo both
	 * invocations pass the `#fd !== null` check and the second
	 * `FileHandle.close()` rejects with EBADF.
	 */
	close(): Promise<void> {
		this.#closePromise ??= this.#doClose();
		return this.#closePromise;
	}

	async #doClose(): Promise<void> {
		withFd(this.filePath).delete(this);
		if (this.#fd !== null) {
			await this.flush();
			await this.#fd.close();
			this.#fd = null;
		}
		this.#fdReady = Promise.resolve(null);
	}
}
