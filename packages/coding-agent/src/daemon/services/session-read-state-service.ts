/**
 * SessionReadStateService — the host-authoritative per-session read state.
 *
 * Seam:
 * - Input: `agent_end` from the daemon session host (via `recordCompletion`),
 *   and the `sessionStatus.mark` / `sessionStatus.markAll` RPCs.
 * - Output: `SessionReadState` per session — `session.list` embeds it on every
 *   row and `sessionStatus.list` serves the whole set, so the desktop, the
 *   phone shell and the tray all read one answer instead of deriving their own
 *   unread cursor from message counts.
 * - Lifecycle: loads once at construction (a small file, read synchronously so
 *   a completion arriving before the first RPC cannot race the load), mutates
 *   in memory, and write-throughs to a private journal with tmp+rename.
 *
 * Persistence is what makes the state host-level rather than window-level: the
 * file survives a daemon restart, so a session marked read on the phone stays
 * read on the desktop and a cleared failure notice does not come back.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@musepi/pi-utils";
import {
	applyMarkRead,
	applyMarkUnread,
	applyTurnCompletion,
	deriveReadState,
	emptyReadRecord,
	normalizeReadRecord,
	type SessionReadRecord,
	type SessionReadState,
} from "../../session/session-read-state";
import type { DaemonService } from "./types";

export interface SessionReadStateServiceDeps {
	/** Journal file path (server injects it beside the daemon's other state). */
	storePath: string;
}

interface StoredSessionRead extends SessionReadRecord {
	sessionId: string;
}

export class SessionReadStateService implements DaemonService {
	readonly key = "sessionReadState";
	readonly routes = {
		"sessionStatus.list": "list",
		"sessionStatus.mark": "mark",
		"sessionStatus.markAll": "markAll",
	} as const;

	readonly #storePath: string;
	readonly #records: Map<string, SessionReadRecord>;
	/** Serializes tmp+rename writes; each task serializes the map at run time,
	 *  so a queued write can never publish an older snapshot than the next one. */
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(deps: SessionReadStateServiceDeps) {
		this.#storePath = deps.storePath;
		this.#records = this.#load();
	}

	/** Derived state for one session; unknown ids read as "nothing unread". */
	stateOf(sessionId: string): SessionReadState {
		return deriveReadState(sessionId, this.#records.get(sessionId) ?? emptyReadRecord());
	}

	/** Fold a finished agent run into the record and persist. Called from the
	 *  host's `agent_end` hook; the memory update lands synchronously, the
	 *  returned promise is the write-through (callers may ignore it). */
	recordCompletion(input: { sessionId: string; failed: boolean; watched: boolean; at?: string }): Promise<void> {
		if (!input.sessionId) return this.#writeQueue;
		const record = this.#records.get(input.sessionId) ?? emptyReadRecord();
		this.#records.set(
			input.sessionId,
			applyTurnCompletion(record, {
				failed: input.failed,
				watched: input.watched,
				at: input.at ?? new Date().toISOString(),
			}),
		);
		return this.#queuePersist();
	}

	/** RPC sessionStatus.list: every tracked record. Sessions without a record
	 *  have never completed a turn on this host and are read. */
	async list(): Promise<{ states: SessionReadState[] }> {
		return {
			states: [...this.#records].map(([sessionId, record]) => deriveReadState(sessionId, record)),
		};
	}

	/** RPC sessionStatus.mark: explicit read or manual unread for one session. */
	async mark(params: {
		sessionId?: unknown;
		read?: unknown;
		unread?: unknown;
	}): Promise<SessionReadState | { error: string }> {
		const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
		if (!sessionId) return { error: "sessionId required" };
		const read = params.read === true;
		const unread = params.unread === true;
		if (read === unread) return { error: "exactly one of read/unread required" };
		const record = this.#records.get(sessionId) ?? emptyReadRecord();
		// A manual unread with no completed turn would otherwise be invisible;
		// keep the pin but leave the comparison counters untouched.
		this.#records.set(sessionId, read ? applyMarkRead(record) : applyMarkUnread(record));
		await this.#queuePersist();
		return this.stateOf(sessionId);
	}

	/** RPC sessionStatus.markAll: read every session the caller lists (its known
	 *  rows) plus any tracked session the daemon still remembers. */
	async markAll(params: { sessionIds?: unknown } = {}): Promise<{ marked: number }> {
		const requested = Array.isArray(params.sessionIds)
			? params.sessionIds.filter((id): id is string => typeof id === "string" && id.length > 0)
			: [];
		const targets = new Set<string>([...this.#records.keys(), ...requested]);
		let marked = 0;
		for (const sessionId of targets) {
			const record = this.#records.get(sessionId);
			if (!record) continue;
			// Sessions already read stay untouched (and are not counted): a second
			// mark-all must be a no-op on the wire.
			if (!record.manualUnread && record.completedTurn <= record.readTurn) continue;
			this.#records.set(sessionId, applyMarkRead(record));
			marked += 1;
		}
		if (marked > 0) await this.#queuePersist();
		return { marked };
	}

	#load(): Map<string, SessionReadRecord> {
		const records = new Map<string, SessionReadRecord>();
		try {
			const parsed = JSON.parse(fs.readFileSync(this.#storePath, "utf8")) as unknown;
			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					const stored = item as Partial<StoredSessionRead> | null;
					if (typeof stored?.sessionId !== "string" || !stored.sessionId) continue;
					records.set(stored.sessionId, normalizeReadRecord(stored));
				}
			}
		} catch (error) {
			// A missing journal is the normal first-run case; a corrupt one must
			// not block session listing — degrade to "everything read".
			if (!isEnoent(error)) {
				logger.warn("SessionReadStateService: journal unreadable, starting empty", {
					storePath: this.#storePath,
				});
			}
		}
		return records;
	}

	#queuePersist(): Promise<void> {
		this.#writeQueue = this.#writeQueue.then(() => this.#persist());
		return this.#writeQueue;
	}

	async #persist(): Promise<void> {
		const payload = JSON.stringify(
			[...this.#records].map(([sessionId, record]): StoredSessionRead => ({ sessionId, ...record })),
		);
		try {
			const dir = path.dirname(this.#storePath);
			await fs.promises.mkdir(dir, { recursive: true });
			const tmp = path.join(dir, `.session-read-state-${crypto.randomBytes(6).toString("hex")}.tmp`);
			await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
			await fs.promises.rename(tmp, this.#storePath);
		} catch (error) {
			// The in-memory records stay authoritative for this daemon run; a failed
			// write only costs the cross-restart guarantee, never the live answer.
			logger.warn("SessionReadStateService: persist failed", {
				storePath: this.#storePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
