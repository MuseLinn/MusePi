/**
 * SQLite materialized-view cache + cross-session query tables for the daemon
 * (daemon Phase 3).
 *
 * Layers:
 * - `materialized_sessions` — one row per session holding the persisted
 *   SessionSnapshot JSON. This is the RECOVERY path and crash-consistency
 *   source; `load()` serves it whole.
 * - `sessions` — same row keyed by session, plus queryable metadata columns
 *   (cwd / model / message_count / created_at). `list()` reads only these.
 * - `messages` / `agents` — row-level projections of the snapshot, updated
 *   transactionally with the snapshot write. These power cross-session
 *   search and statistics that a whole-JSON row cannot answer.
 *
 * The journal remains the single source of truth; the snapshot JSON is the
 * consistency anchor; the projected tables are a redundant query index. A
 * crash can leave the projected tables slightly behind the last snapshot
 * (the throttled persist window), but recovery never reads them, so no
 * data-loss path exists.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MessageEntry, SessionState } from "@musepi/pi-wire";
import type { SessionSnapshot } from "@musepi/sdk";

export interface MaterializedRow {
	sessionId: string;
	cursor: number;
	updatedAt: number;
	createdAt: number;
	cwd: string;
	model: string | null;
	messageCount: number;
	/** Fork source session (session-tree parent); null for roots. */
	parentId: string | null;
}

export interface MessageHit {
	sessionId: string;
	seq: number;
	role: string;
	model: string | null;
	content: string;
	timestamp: number;
}

interface SessionRow {
	session_id: string;
	cursor: number;
	created_at: number;
	updated_at: number;
	cwd: string;
	model: string | null;
	message_count: number;
	parent_id: string | null;
}

interface MessageRow {
	session_id: string;
	seq: number;
	role: string;
	model: string | null;
	content: string;
	timestamp: number;
}

/** Extract a displayable text form from message content (text | image | array). */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map(block =>
				block && typeof block === "object" && "text" in block ? String((block as { text: string }).text) : "",
			)
			.filter(Boolean)
			.join("\n");
	}
	if (content && typeof content === "object" && "text" in content) return String((content as { text: string }).text);
	return "";
}

export class ViewStore {
	readonly #db: Database;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath, { create: true });
		// Multiple daemon processes can share the journal dir (test daemons
		// alongside the user's) — a transient writer lock must WAIT, not throw
		// SQLITE_BUSY and crash the daemon from a fire-and-forget persist.
		this.#db.exec("PRAGMA busy_timeout = 5000");
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS materialized_sessions (
				session_id TEXT PRIMARY KEY,
				cursor INTEGER NOT NULL,
				snapshot TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT PRIMARY KEY,
				cursor INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				cwd TEXT NOT NULL DEFAULT '',
				model TEXT,
				message_count INTEGER NOT NULL DEFAULT 0,
				parent_id TEXT
			)
		`);
		// Old databases lack parent_id — add it idempotently.
		const cols = this.#db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
		if (!cols.some(c => c.name === "parent_id")) {
			this.#db.run("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
		}
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS messages (
				session_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				role TEXT NOT NULL,
				model TEXT,
				content TEXT NOT NULL DEFAULT '',
				timestamp INTEGER NOT NULL,
				PRIMARY KEY (session_id, seq)
			)
		`);
		this.#db.run(`
			CREATE TABLE IF NOT EXISTS agents (
				session_id TEXT NOT NULL,
				id TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'main',
				status TEXT NOT NULL DEFAULT 'idle',
				created_at INTEGER NOT NULL,
				last_activity INTEGER NOT NULL,
				PRIMARY KEY (session_id, id)
			)
		`);
		this.#db.run("PRAGMA journal_mode = WAL");
	}

	/** Persist a snapshot AND sync the query tables, atomically. */
	upsert(sessionId: string, snapshot: SessionSnapshot, parentId: string | null = null): void {
		this.#db.transaction(() => {
			this.#db
				.query(
					`INSERT INTO materialized_sessions (session_id, cursor, snapshot, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(session_id) DO UPDATE SET
					   cursor = excluded.cursor,
					   snapshot = excluded.snapshot,
					   updated_at = excluded.updated_at`,
				)
				.run(sessionId, snapshot.cursor, JSON.stringify(snapshot), Date.now());

			const state = snapshot.state as SessionState | undefined;
			// Model metadata: prefer the last assistant message's model (always
			// present once a turn ran), falling back to state.model.
			let model: string | null = null;
			for (const entry of snapshot.entries) {
				if (
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					"model" in entry.message &&
					typeof (entry.message as { model?: unknown }).model === "string"
				) {
					model = (entry.message as { model: string }).model;
				}
			}
			if (!model && state?.model) model = `${state.model.provider}/${state.model.id}`;
			const messageCount = snapshot.entries.filter(e => e.type === "message").length;
			const createdAt =
				Date.parse(
					typeof snapshot.header === "object" && snapshot.header
						? String((snapshot.header as { timestamp?: string }).timestamp ?? "")
						: "",
				) || Date.now();
			this.#db
				.query(
					`INSERT INTO sessions (session_id, cursor, created_at, updated_at, cwd, model, message_count, parent_id)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(session_id) DO UPDATE SET
					   cursor = excluded.cursor,
					   updated_at = excluded.updated_at,
					   cwd = excluded.cwd,
					   model = excluded.model,
					   message_count = excluded.message_count`,
				)
				.run(sessionId, snapshot.cursor, createdAt, Date.now(), state?.cwd ?? "", model, messageCount, parentId);

			this.#db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
			let seq = 0;
			for (const entry of snapshot.entries) {
				if (entry.type !== "message") continue;
				const msg = (entry as MessageEntry).message;
				this.#db
					.query(
						"INSERT INTO messages (session_id, seq, role, model, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(
						sessionId,
						seq++,
						msg.role,
						"model" in msg ? (String((msg as { model?: unknown }).model ?? "") ?? null) : null,
						"content" in msg ? contentToText(msg.content) : "",
						// Mid-stream wire messages carry no timestamp yet; the
						// entry-level timestamp (message_start time) is the
						// closest stable value. Coalescing here keeps a
						// shutdown/close during streaming from tripping the
						// NOT NULL constraint (and killing the daemon).
						msg.timestamp ?? (Date.parse(entry.timestamp) || Date.now()),
					);
			}

			this.#db.query("DELETE FROM agents WHERE session_id = ?").run(sessionId);
			for (const agent of snapshot.agents) {
				this.#db
					.query(
						"INSERT INTO agents (session_id, id, kind, status, created_at, last_activity) VALUES (?, ?, ?, ?, ?, ?)",
					)
					.run(sessionId, agent.id, agent.kind, agent.status, agent.createdAt, agent.lastActivity);
			}
		})();
	}

	/** Load a session's persisted snapshot (recovery path), or undefined. */
	load(sessionId: string): SessionSnapshot | undefined {
		const row = this.#db.query("SELECT * FROM materialized_sessions WHERE session_id = ?").get(sessionId) as {
			snapshot: string;
		} | null;
		if (!row) return undefined;
		try {
			return JSON.parse(row.snapshot) as SessionSnapshot;
		} catch {
			return undefined;
		}
	}

	/** All sessions with queryable metadata — feeds session.list. */
	list(): MaterializedRow[] {
		const rows = this.#db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as SessionRow[];
		return rows.map(r => ({
			sessionId: r.session_id,
			cursor: r.cursor,
			updatedAt: r.updated_at,
			createdAt: r.created_at,
			cwd: r.cwd,
			model: r.model,
			messageCount: r.message_count,
			parentId: r.parent_id ?? null,
		}));
	}

	/**
	 * Cross-session message search (LIKE on message text). Returns matching
	 * messages with their session; the caller groups by session.
	 */
	search(query: string, limit = 50): MessageHit[] {
		const like = `%${query}%`;
		const rows = this.#db
			.query(
				`SELECT session_id, seq, role, model, content, timestamp
				 FROM messages
				 WHERE content LIKE ?
				 ORDER BY timestamp DESC
				 LIMIT ?`,
			)
			.all(like, limit) as MessageRow[];
		return rows.map(r => ({
			sessionId: r.session_id,
			seq: r.seq,
			role: r.role,
			model: r.model,
			content: r.content,
			timestamp: r.timestamp,
		}));
	}

	/** All message rows for one session (history viewer), oldest first. */
	messagesFor(sessionId: string, limit = 500): MessageHit[] {
		const rows = this.#db
			.query(
				`SELECT session_id, seq, role, model, content, timestamp
				 FROM messages
				 WHERE session_id = ?
				 ORDER BY seq ASC
				 LIMIT ?`,
			)
			.all(sessionId, limit) as MessageRow[];
		return rows.map(r => ({
			sessionId: r.session_id,
			seq: r.seq,
			role: r.role,
			model: r.model,
			content: r.content,
			timestamp: r.timestamp,
		}));
	}

	/** Earliest user message text for a session — used as the display title
	 * (opencode/Codex convention: title = first user request). */
	firstUserMessage(sessionId: string): string {
		const row = this.#db
			.query(`SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY seq ASC LIMIT 1`)
			.get(sessionId) as { content: string } | undefined;
		return row ? contentToText(row.content).trim() : "";
	}

	remove(sessionId: string): void {
		this.#db.transaction(() => {
			this.#db.query("DELETE FROM materialized_sessions WHERE session_id = ?").run(sessionId);
			this.#db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
			this.#db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
			this.#db.query("DELETE FROM agents WHERE session_id = ?").run(sessionId);
		})();
	}

	close(): void {
		this.#db.close();
	}
}

/** Default store location next to the journal. */
export function viewStorePath(journalDir: string): string {
	return path.join(journalDir, "materialized.db");
}
