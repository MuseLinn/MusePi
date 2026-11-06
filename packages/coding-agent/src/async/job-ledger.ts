/**
 * Durable ledger for background jobs.
 *
 * `AsyncJobManager` keeps live job state in memory (output ring, abort
 * controller, delivery promise). That is the right shape for the hot path, but
 * it means a daemon restart silently forgets every running job. This ledger
 * records the durable facts — identity, owner/session, status and final text —
 * so startup can mark orphans `lost` instead of pretending they never existed.
 *
 * It is deliberately not a queue: the ledger never re-runs a job. Jobs can have
 * external side effects, so recovery only reports the unknown outcome.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export type DurableJobStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface DurableJobRecord {
	id: string;
	sessionId?: string;
	type: string;
	label: string;
	status: DurableJobStatus;
	startTime: number;
	updatedAt: number;
	ownerId?: string;
	agentId?: string;
	toolCallId?: string;
	resultText?: string;
	delivered: boolean;
}

export interface RegisterDurableJob {
	id: string;
	sessionId?: string;
	type: string;
	label: string;
	startTime: number;
	ownerId?: string;
	agentId?: string;
	toolCallId?: string;
}

interface JobRow {
	id: string;
	session_id: string | null;
	type: string;
	label: string;
	status: DurableJobStatus;
	start_time: number;
	updated_at: number;
	owner_id: string | null;
	agent_id: string | null;
	tool_call_id: string | null;
	result_text: string | null;
	delivered: number;
}

function toRecord(row: JobRow): DurableJobRecord {
	return {
		id: row.id,
		...(row.session_id ? { sessionId: row.session_id } : {}),
		type: row.type,
		label: row.label,
		status: row.status,
		startTime: row.start_time,
		updatedAt: row.updated_at,
		...(row.owner_id ? { ownerId: row.owner_id } : {}),
		...(row.agent_id ? { agentId: row.agent_id } : {}),
		...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
		...(row.result_text !== null ? { resultText: row.result_text } : {}),
		delivered: row.delivered === 1,
	};
}

export class JobLedger {
	readonly #db: Database;

	constructor(file: string) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		this.#db = new Database(file);
		this.#db.exec("PRAGMA journal_mode = WAL;");
		this.#db.exec(`
			CREATE TABLE IF NOT EXISTS async_jobs (
				id TEXT PRIMARY KEY,
				session_id TEXT,
				type TEXT NOT NULL,
				label TEXT NOT NULL,
				status TEXT NOT NULL,
				start_time INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				owner_id TEXT,
				agent_id TEXT,
				tool_call_id TEXT,
				result_text TEXT,
				delivered INTEGER NOT NULL DEFAULT 0
			);
			CREATE INDEX IF NOT EXISTS async_jobs_session
				ON async_jobs(session_id, updated_at DESC);
		`);
	}

	register(job: RegisterDurableJob): void {
		const now = Date.now();
		this.#db
			.query(
				`INSERT OR REPLACE INTO async_jobs
					(id, session_id, type, label, status, start_time, updated_at, owner_id, agent_id, tool_call_id, result_text, delivered)
				 VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, NULL, 0)`,
			)
			.run(
				job.id,
				job.sessionId ?? null,
				job.type,
				job.label,
				job.startTime,
				now,
				job.ownerId ?? null,
				job.agentId ?? null,
				job.toolCallId ?? null,
			);
	}

	finish(id: string, status: Exclude<DurableJobStatus, "running" | "lost">, resultText?: string): void {
		this.#db
			.query(
				`UPDATE async_jobs
				 SET status = ?, updated_at = ?, result_text = ?
				 WHERE id = ?`,
			)
			.run(status, Date.now(), resultText ?? null, id);
	}

	markDelivered(id: string): void {
		this.#db.query("UPDATE async_jobs SET delivered = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
	}

	/** Startup reconciliation: a `running` row has no live process anymore.
	 *  It becomes `lost` (unknown outcome), never `failed` — retrying a job with
	 *  external side effects is the caller's decision, not the ledger's. */
	recoverRunning(): DurableJobRecord[] {
		const now = Date.now();
		this.#db.query("UPDATE async_jobs SET status = 'lost', updated_at = ? WHERE status = 'running'").run(now);
		return this.listLost();
	}

	listLost(limit = 50): DurableJobRecord[] {
		const rows = this.#db
			.query(
				`SELECT * FROM async_jobs
				 WHERE status = 'lost'
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(limit) as JobRow[];
		return rows.map(toRecord);
	}

	/** Finished-but-undelivered rows for one session. A restart can replay the
	 *  text into the transcript instead of losing the result with the process. */
	listUndelivered(sessionId: string, limit = 20): DurableJobRecord[] {
		const rows = this.#db
			.query(
				`SELECT * FROM async_jobs
				 WHERE session_id = ? AND delivered = 0
				   AND status IN ('completed', 'failed', 'cancelled')
				 ORDER BY updated_at ASC
				 LIMIT ?`,
			)
			.all(sessionId, limit) as JobRow[];
		return rows.map(toRecord);
	}

	/** Lost rows for one session (or session-less rows, which predate the
	 *  session field). Used by `session.jobs` so a restarted daemon can show
	 *  what it could not recover. */
	listLostForSession(sessionId: string, limit = 20): DurableJobRecord[] {
		const rows = this.#db
			.query(
				`SELECT * FROM async_jobs
				 WHERE status = 'lost' AND (session_id = ? OR session_id IS NULL)
				 ORDER BY updated_at DESC
				 LIMIT ?`,
			)
			.all(sessionId, limit) as JobRow[];
		return rows.map(toRecord);
	}

	close(): void {
		this.#db.close();
	}
}
