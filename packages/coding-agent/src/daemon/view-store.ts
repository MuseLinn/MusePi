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
import type { MessageEntry, SessionEntry, SessionState } from "@musepi/pi-wire";
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
	/** 会话预设(mode)id — 持久化自快照 header（persistHeaderPatch 落盘），
	 *  live 会话在 knownSessions 里以内存值为权威覆盖。侧栏悬浮卡的
	 *  模式行消费；null = 未设预设。 */
	modeId: string | null;
	/** M3.2 创作面 project metadata — 持久化自快照 header（创建路径
	 *  persistHeaderPatch 落盘），保留语义与 modeId 相同（视图重建不携带，
	 *  依赖本列回注）。null = 非创作会话。 */
	projectMetadata: Record<string, unknown> | null;
	/** M4 P1 连接器按会话白名单（原始 server 名数组）— 持久化自快照 header
	 *  （persistHeaderPatch 落盘），保留语义与 modeId 相同。null = 未配置
	 *  （存量「连接即启用」语义）；[] = 已配置且零选择（会话内零 MCP 工具）。 */
	mcpServers: string[] | null;
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
	mode_id: string | null;
	project_metadata: string | null;
	mcp_servers: string | null;
}

interface MessageRow {
	session_id: string;
	seq: number;
	role: string;
	model: string | null;
	content: string;
	timestamp: number;
}

/** P1-13 constructor options. */
export interface ViewStoreOptions {
	/** Test/diagnostic hook: reports how many message-projection rows a
	 *  persist actually wrote and through which path. Production passes
	 *  nothing; contract tests assert write counts stay proportional to
	 *  the delta (a regression to whole-table rewrites is caught here). */
	hooks?: {
		onMessageRows?(kind: "full" | "append" | "update", count: number): void;
	};
	/** Minimum interval between materialized_sessions snapshot-JSON writes
	 *  for one session (default 1000ms). Streaming persists coalesce to one
	 *  O(session-size) stringify per interval; force writes (dispose /
	 *  compaction / header patch) are never throttled. The journal remains
	 *  the source of truth — a throttled snapshot only means slightly more
	 *  replay after a crash. */
	minSnapshotJsonIntervalMs?: number;
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
	readonly #hooks: ViewStoreOptions["hooks"];
	readonly #minSnapshotJsonIntervalMs: number;
	/** P1-13: per-session message-projection index — entryId → positional
	 *  seq. Lets a persist verify the journal-append regime (ids align with
	 *  positions) and write ONLY the changed rows instead of DELETE+rebuild.
	 *  Keys are short strings — bounded and cleaned by remove(). */
	#msgIndex = new Map<string, Map<string, number>>();
	/** Highest seq handed out per session (append path continues at +1). */
	#msgMaxSeq = new Map<string, number>();
	/** P1-13: snapshot-JSON write throttle state per session. */
	#lastJsonEntriesRef = new Map<string, unknown>();
	#lastJsonAt = new Map<string, number>();

	constructor(dbPath: string, options?: ViewStoreOptions) {
		this.#hooks = options?.hooks;
		this.#minSnapshotJsonIntervalMs = options?.minSnapshotJsonIntervalMs ?? 1000;
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
		// Old databases lack mode_id (session preset id from the snapshot
		// header) — same idempotent path.
		if (!cols.some(c => c.name === "mode_id")) {
			this.#db.run("ALTER TABLE sessions ADD COLUMN mode_id TEXT");
		}
		// Old databases lack project_metadata (M3.2 creation-surface metadata,
		// stored as its serialized JSON from the snapshot header).
		if (!cols.some(c => c.name === "project_metadata")) {
			this.#db.run("ALTER TABLE sessions ADD COLUMN project_metadata TEXT");
		}
		// Old databases lack mcp_servers (M4 P1 per-session connector allowlist,
		// serialized JSON string array from the snapshot header) — same
		// idempotent path.
		if (!cols.some(c => c.name === "mcp_servers")) {
			this.#db.run("ALTER TABLE sessions ADD COLUMN mcp_servers TEXT");
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

	/** Persist a snapshot AND sync the query tables, atomically.
	 *
	 *  P1-13 incremental projection: the message table is no longer
	 *  DELETE+rebuilt on every persist. When the session's entry ids still
	 *  align positionally (the journal-append regime — prepend/truncate/
	 *  reorder fall back to a full rewrite), only `options.changed` rows
	 *  are written: known ids UPDATE in place, new ids INSERT at maxSeq+1.
	 *  The materialized_sessions snapshot JSON is additionally throttled to
	 *  one write per `minSnapshotJsonIntervalMs` while streaming (the
	 *  journal stays authoritative; `force` bypasses for lifecycle points). */
	upsert(
		sessionId: string,
		snapshot: SessionSnapshot,
		parentId: string | null = null,
		options?: { force?: boolean; changed?: readonly SessionEntry[] },
	): void {
		// Session preset id. The MaterializedView projection (rebuilt from wire
		// events) never carries modeId; only persistHeaderPatch — the create /
		// setMode paths — writes it, and always with an explicit value (incl.
		// null to clear). Every other persist path (streaming schedulePersist,
		// idle-close, compaction) replays the view snapshot, whose header has NO
		// modeId key, so a naive upsert would null the preset on every event and
		// the session would fall back to "工作模式" after a restart. Preserve the
		// previously-persisted preset unless the caller explicitly set the key.
		const headerObj =
			typeof snapshot.header === "object" && snapshot.header
				? (snapshot.header as unknown as Record<string, unknown>)
				: {};
		const headerHasModeId = "modeId" in headerObj;
		let modeId: string | null = headerHasModeId ? ((headerObj.modeId ?? null) as string | null) : null;
		if (!headerHasModeId) {
			const prev = this.#db.query("SELECT mode_id FROM sessions WHERE session_id = ?").get(sessionId) as
				| { mode_id: string | null }
				| undefined;
			modeId = prev?.mode_id ?? null;
		}
		// M3.2 project metadata: same preservation contract as modeId — the
		// view projection never carries it; only persistHeaderPatch (the
		// create path) writes it explicitly. Streaming/idle/compaction
		// persists replay the snapshot header WITHOUT the key, so re-inject
		// the previously-persisted value or the creation config would be
		// dropped on the first agent event.
		let projectMetadata: Record<string, unknown> | null = null;
		if ("projectMetadata" in headerObj) {
			// Explicit key wins, including null / non-object to CLEAR.
			const v = headerObj.projectMetadata;
			if (typeof v === "object" && v !== null && !Array.isArray(v)) {
				projectMetadata = v as Record<string, unknown>;
			}
		} else {
			const prev = this.#db.query("SELECT project_metadata FROM sessions WHERE session_id = ?").get(sessionId) as
				| { project_metadata: string | null }
				| undefined;
			if (prev?.project_metadata) {
				try {
					const parsed = JSON.parse(prev.project_metadata) as unknown;
					if (typeof parsed === "object" && parsed !== null) projectMetadata = parsed as Record<string, unknown>;
				} catch {
					// Corrupt column value — treat as absent, next explicit write repairs it.
				}
			}
		}
		// M4 P1 connector allowlist: same preservation contract as modeId —
		// the view projection never carries mcpServers; only persistHeaderPatch
		// (the connectors.setSelected path) writes it explicitly. null = 未配置
		// (legacy all-on); [] = configured-empty and MUST survive streaming
		// persists (the empty array is meaningful, not "absent").
		let mcpServers: string[] | null = null;
		if ("mcpServers" in headerObj) {
			const v = headerObj.mcpServers;
			if (v === null || v === undefined) {
				mcpServers = null;
			} else if (Array.isArray(v)) {
				mcpServers = v.filter((s): s is string => typeof s === "string" && s.length > 0);
			}
		} else {
			const prev = this.#db.query("SELECT mcp_servers FROM sessions WHERE session_id = ?").get(sessionId) as
				| { mcp_servers: string | null }
				| undefined;
			if (prev?.mcp_servers) {
				try {
					const parsed = JSON.parse(prev.mcp_servers) as unknown;
					if (Array.isArray(parsed)) {
						mcpServers = parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
					}
				} catch {
					// Corrupt column value — treat as absent, next explicit write repairs it.
				}
			}
		}
		// Keep the preset / creation metadata riding the stored snapshot header
		// too (when the incoming header lacks the key), so the reactivation
		// path (adopt) can read persisted.header.<key> back after a restart —
		// not just the query columns.
		const headerPatch: Record<string, unknown> = {};
		if (!headerHasModeId && modeId != null) headerPatch.modeId = modeId;
		if (!("projectMetadata" in headerObj) && projectMetadata) headerPatch.projectMetadata = projectMetadata;
		if (!("mcpServers" in headerObj) && mcpServers !== null) headerPatch.mcpServers = mcpServers;
		const snapshotToStore: SessionSnapshot =
			Object.keys(headerPatch).length > 0
				? ({ ...snapshot, header: { ...headerObj, ...headerPatch } } as unknown as SessionSnapshot)
				: snapshot;
		this.#db.transaction(() => {
			// P1-13: throttle the O(session-size) snapshot JSON to one write
			// per minSnapshotJsonIntervalMs while streaming (content frames
			// arrive every 100ms persist). The journal remains authoritative;
			// a skipped write only means slightly more replay after a crash.
			// Lifecycle points (dispose / compaction / header patch) pass
			// force and are never throttled.
			const entriesRef: unknown = snapshot.entries;
			const lastRef = this.#lastJsonEntriesRef.get(sessionId);
			const lastAt = this.#lastJsonAt.get(sessionId) ?? 0;
			const nowMs = Date.now();
			if (
				options?.force === true ||
				lastRef === undefined ||
				(entriesRef !== lastRef && nowMs - lastAt >= this.#minSnapshotJsonIntervalMs)
			) {
				this.#db
					.query(
						`INSERT INTO materialized_sessions (session_id, cursor, snapshot, updated_at)
						 VALUES (?, ?, ?, ?)
						 ON CONFLICT(session_id) DO UPDATE SET
						   cursor = excluded.cursor,
						   snapshot = excluded.snapshot,
						   updated_at = excluded.updated_at`,
					)
					.run(sessionId, snapshot.cursor, JSON.stringify(snapshotToStore), nowMs);
				this.#lastJsonEntriesRef.set(sessionId, entriesRef);
				this.#lastJsonAt.set(sessionId, nowMs);
			}

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
			// Last-ACTIVITY stamp (openchamber `time.updated` parity): the newest
			// entry timestamp, NOT the persist wall-clock. Persisting happens on
			// VIEW too (activate, idle-close dispose), and a view-stamped
			// updated_at re-ranks the session for merely being opened (bitfun's
			// nav list documents the same trap: "rows do not jump to the top on
			// click"). Entries are ISO-stamped at append; max() is robust to any
			// out-of-order replay, and an empty session falls back to createdAt.
			let lastActivity = createdAt;
			for (const entry of snapshot.entries) {
				const ts = Date.parse(entry.timestamp);
				if (Number.isFinite(ts) && ts > lastActivity) lastActivity = ts;
			}
			this.#db
				.query(
					`INSERT INTO sessions (session_id, cursor, created_at, updated_at, cwd, model, message_count, parent_id, mode_id, project_metadata, mcp_servers)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
				   cursor = excluded.cursor,
				   updated_at = excluded.updated_at,
				   cwd = excluded.cwd,
				   model = excluded.model,
				   message_count = excluded.message_count,
				   parent_id = excluded.parent_id,
				   mode_id = excluded.mode_id,
				   project_metadata = excluded.project_metadata,
				   mcp_servers = excluded.mcp_servers`,
				)
				.run(
					sessionId,
					snapshot.cursor,
					createdAt,
					lastActivity,
					state?.cwd ?? "",
					model,
					messageCount,
					parentId,
					// Session preset id — preserved from the prior persist when the
					// view snapshot lacks it, so streaming / idle / compaction
					// persists never clobber a setMode'd mode (persistHeaderPatch is
					// the only explicit writer). null = no preset armed.
					modeId,
					// M3.2 creation metadata — same preservation contract (see the
					// headerPatch assembly above). null = not a creation session.
					projectMetadata ? JSON.stringify(projectMetadata) : null,
					// M4 P1 connector allowlist — same preservation contract.
					// null = unconfigured (legacy all-on semantics survive every
					// streaming persist); "[]" = configured-empty, a meaningful
					// state that must round-trip through rewrites.
					mcpServers !== null ? JSON.stringify(mcpServers) : null,
				);

			// P1-13: message projection. Append regime (ids still align with
			// their positional seqs — the only shape the daemon view ever
			// produces) writes just the changed rows; prepend/truncate/reorder
			// fall back to the whole-table rebuild.
			const msgEntries: MessageEntry[] = [];
			for (const entry of snapshot.entries) {
				if (entry.type === "message") msgEntries.push(entry as MessageEntry);
			}
			const index = this.#msgIndex.get(sessionId);
			const prevSize = index?.size ?? 0;
			let aligned = index !== undefined && msgEntries.length >= prevSize;
			if (aligned && index) {
				// Head must be positionally identical (id → seq === position)…
				for (let i = 0; i < prevSize; i++) {
					if (index.get(msgEntries[i].id) !== i) {
						aligned = false;
						break;
					}
				}
				// …and the tail beyond the previous size must be genuinely new
				// ids — a tail id that already has a seq is a reorder/prepend
				// in disguise, not an append.
				if (aligned) {
					for (let i = prevSize; i < msgEntries.length; i++) {
						if (index.has(msgEntries[i].id)) {
							aligned = false;
							break;
						}
					}
				}
			}
			const rowValues = (msg: MessageEntry["message"], entry: SessionEntry): Array<string | number | null> => [
				msg.role,
				"model" in msg ? (String((msg as { model?: unknown }).model ?? "") ?? null) : null,
				"content" in msg ? contentToText(msg.content) : "",
				// Mid-stream wire messages carry no timestamp yet; the
				// entry-level timestamp (message_start time) is the closest
				// stable value. Coalescing here keeps a shutdown/close during
				// streaming from tripping the NOT NULL constraint (and killing
				// the daemon).
				msg.timestamp ?? (Date.parse(entry.timestamp) || Date.now()),
			];
			const insertStmt = this.#db.query(
				"INSERT INTO messages (session_id, seq, role, model, content, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
			);
			const updateStmt = this.#db.query(
				"UPDATE messages SET role = ?, model = ?, content = ?, timestamp = ? WHERE session_id = ? AND seq = ?",
			);
			if (!aligned || !index) {
				this.#db.query("DELETE FROM messages WHERE session_id = ?").run(sessionId);
				const freshIndex = new Map<string, number>();
				for (let i = 0; i < msgEntries.length; i++) {
					const entry = msgEntries[i];
					insertStmt.run(sessionId, i, ...rowValues(entry.message, entry));
					freshIndex.set(entry.id, i);
				}
				this.#msgIndex.set(sessionId, freshIndex);
				this.#msgMaxSeq.set(sessionId, msgEntries.length - 1);
				this.#hooks?.onMessageRows?.("full", msgEntries.length);
			} else {
				let updates = 0;
				let appends = 0;
				if (options?.changed) {
					for (const entry of options.changed) {
						if (entry.type !== "message") continue;
						const msg = (entry as MessageEntry).message;
						const seq = index.get(entry.id);
						if (seq !== undefined) {
							updateStmt.run(...rowValues(msg, entry), sessionId, seq);
							updates++;
						} else {
							const next = (this.#msgMaxSeq.get(sessionId) ?? -1) + 1;
							insertStmt.run(sessionId, next, ...rowValues(msg, entry));
							index.set(entry.id, next);
							this.#msgMaxSeq.set(sessionId, next);
							appends++;
						}
					}
				}
				if (updates > 0) this.#hooks?.onMessageRows?.("update", updates);
				if (appends > 0) this.#hooks?.onMessageRows?.("append", appends);
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
		return rows.map(r => {
			let projectMetadata: Record<string, unknown> | null = null;
			if (r.project_metadata) {
				try {
					const parsed = JSON.parse(r.project_metadata) as unknown;
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						projectMetadata = parsed as Record<string, unknown>;
					}
				} catch {
					// Corrupt column value — surface as absent rather than failing the list.
				}
			}
			let mcpServers: string[] | null = null;
			if (r.mcp_servers) {
				try {
					const parsed = JSON.parse(r.mcp_servers) as unknown;
					if (Array.isArray(parsed)) {
						mcpServers = parsed.filter((s): s is string => typeof s === "string" && s.length > 0);
					}
				} catch {
					// Corrupt column value — surface as absent rather than failing the list.
				}
			}
			return {
				sessionId: r.session_id,
				cursor: r.cursor,
				updatedAt: r.updated_at,
				createdAt: r.created_at,
				cwd: r.cwd,
				model: r.model,
				messageCount: r.message_count,
				parentId: r.parent_id ?? null,
				modeId: r.mode_id ?? null,
				projectMetadata,
				mcpServers,
			};
		});
	}

	/**
	 * Message search (LIKE on message text). Returns matching messages with
	 * their session; the caller groups by session. `sessionId` narrows the
	 * scan to one conversation — the ⌘F find bar needs the whole session
	 * ordered newest-first, which a cross-session LIMIT would starve once
	 * other sessions match too.
	 */
	search(query: string, limit = 50, sessionId?: string): MessageHit[] {
		const like = `%${query}%`;
		const rows = (
			sessionId
				? this.#db
						.query(
							`SELECT session_id, seq, role, model, content, timestamp
							 FROM messages
							 WHERE content LIKE ? AND session_id = ?
							 ORDER BY timestamp DESC
							 LIMIT ?`,
						)
						.all(like, sessionId, limit)
				: this.#db
						.query(
							`SELECT session_id, seq, role, model, content, timestamp
							 FROM messages
							 WHERE content LIKE ?
							 ORDER BY timestamp DESC
							 LIMIT ?`,
						)
						.all(like, limit)
		) as MessageRow[];
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
		// P1-13: drop the incremental-persist state with the rows — a removed
		// session that comes back must rebuild from a full write.
		this.#msgIndex.delete(sessionId);
		this.#msgMaxSeq.delete(sessionId);
		this.#lastJsonEntriesRef.delete(sessionId);
		this.#lastJsonAt.delete(sessionId);
	}

	close(): void {
		this.#db.close();
	}
}

/** Default store location next to the journal. */
export function viewStorePath(journalDir: string): string {
	return path.join(journalDir, "materialized.db");
}
