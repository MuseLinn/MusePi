/**
 * Workspace file-content index (settings → 索引库 → 代码库).
 *
 * Zed-style local code indexing: a background scan walks the workspace,
 * stores text-file contents in a SQLite FTS5 table (unicode61 tokenizer —
 * CJK-aware prefix queries), and the GUI queries it for instant search.
 * All data stays local (~/.musepi/agent/file-index.db).
 *
 * Design notes:
 * - FTS5 unicode61 keeps a contiguous CJK run as ONE token, so a Chinese
 *   query like `看板*` (no quotes) is a token prefix match and works for
 *   any length ≥2 — verified against bun:sqlite.
 * - Incremental: rows carry mtime/size; unchanged files are skipped.
 * - Bounds: text files ≤ 2 MiB, at most MAX_FILES (50_000, mirroring the
 *   reference "索引新文件夹 <50,000 文件" cap); binary files (NUL byte)
 *   and the standard heavy directories are skipped.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_FILES = 50_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Directories never indexed (workspace noise). */
const SKIP_DIRS = new Set([
	".git",
	".hg",
	".svn",
	"node_modules",
	".venv",
	"venv",
	"dist",
	"build",
	"target",
	".next",
	".cache",
	"__pycache__",
	".turbo",
	".yarn",
]);
const SKIP_EXT = new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".pdf",
	".zip",
	".gz",
	".tar",
	".mp4",
	".mp3",
	".wav",
	".woff",
	".woff2",
	".ttf",
	".icns",
	".sqlite",
	".db",
	".wasm",
]);

export interface IndexStatus {
	enabled: boolean;
	dir: string | null;
	files: number;
	lastScan: number | null;
	scanning: boolean;
	skipped: number;
	truncated: boolean;
}

export interface IndexHit {
	path: string;
	snippet: string;
}

/** Convert a raw user query into an FTS5 prefix MATCH (CJK-safe). */
export function prefixQuery(q: string): string {
	return `${q.trim().replace(/\s+/g, " ")}*`;
}

/**
 * CJK bigram expansion: unicode61 keeps a contiguous CJK run as ONE token,
 * so a query for a word inside the run ("乘法" inside "看板乘法") can never
 * match. Expanding both sides into adjacent 2-char bigrams turns any CJK
 * substring into an exact token: 看板乘法 → 看板 板功 功能 (queries get the
 * same expansion + per-token prefix, so 看板/板功/功能/看板乘法 all hit).
 * Non-CJK text passes through untouched.
 */
export function expandCjk(s: string): string {
	return s.replace(/[\u4e00-\u9fff]+/g, run => {
		const grams: string[] = [];
		for (let i = 0; i < run.length; i++) grams.push(run.slice(i, i + 2));
		return grams.join(" ");
	});
}

/** Index-side: bigram-expanded text (contents stored for snippet only —
 * the FTS column is expanded; snippet() reads the ORIGINAL column). */
export function indexText(s: string): string {
	return expandCjk(s);
}

/** Query-side: bigram expansion + per-token prefix (implicit AND). */
export function indexQuery(q: string): string {
	return expandCjk(q.trim().replace(/\s+/g, " "))
		.split(" ")
		.filter(Boolean)
		.map(t => `${t}*`)
		.join(" ");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idx_meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS idx_files (
	path TEXT PRIMARY KEY,
	mtime REAL NOT NULL,
	size INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS idx_fts USING fts5(
	path UNINDEXED,
	content,
	expanded
);
`;

export class FileIndexService {
	#db: Database;
	#dir: string | null = null;
	#enabled = false;
	#files = 0;
	#lastScan: number | null = null;
	#scanning = false;
	#skipped = 0;
	#truncated = false;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		this.#db = new Database(dbPath);
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run("PRAGMA journal_mode = WAL");
		this.#db.run(SCHEMA);
		const row = this.#db.query("SELECT value FROM idx_meta WHERE key = 'enabled'").get() as
			| { value: string }
			| undefined;
		this.#enabled = row?.value === "1";
		this.#files = (this.#db.query("SELECT COUNT(*) AS n FROM idx_files").get() as { n: number }).n;
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	status(): IndexStatus {
		return {
			enabled: this.#enabled,
			dir: this.#dir,
			files: this.#files,
			lastScan: this.#lastScan,
			scanning: this.#scanning,
			skipped: this.#skipped,
			truncated: this.#truncated,
		};
	}

	/** Enable/disable (persisted in idx_meta). */
	setEnabled(on: boolean): void {
		this.#enabled = on;
		this.#db
			.query(
				"INSERT INTO idx_meta (key, value) VALUES ('enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(on ? "1" : "0");
	}

	/**
	 * Background incremental scan of `dir`. Walks the tree, upserts changed
	 * text files into FTS5, drops rows whose files vanished. Returns once
	 * the scan finishes (callers may fire-and-forget; status().scanning
	 * reflects the running pass). Safe to call again while running — the
	 * second call awaits the in-flight one.
	 */
	async scan(dir: string): Promise<void> {
		// Throttle: the GUI polls every 2s and re-triggers scans; skip a
		// fresh pass shortly after a completed one (incremental anyway, but
		// the walk itself costs a full readdir sweep on big repos).
		if (this.#lastScan && Date.now() - this.#lastScan < 10_000) return;
		this.#dir = dir;
		if (this.#scanning) {
			// Wait for the running pass to finish, then re-scan (the second
			// call carries a newer snapshot of the tree).
			await this.#inflight;
			return this.scan(dir);
		}
		this.#scanning = true;
		this.#skipped = 0;
		this.#truncated = false;
		const started = Date.now();
		try {
			this.#inflight = this.#scanDir(dir);
			await this.#inflight;
		} finally {
			this.#inflight = null;
			this.#scanning = false;
			this.#lastScan = Date.now();
		}
		console.log(
			`[file-index] scan done: ${this.#files} files, ${this.#skipped} skipped, ${Date.now() - started}ms (${dir})`,
		);
	}

	#inflight: Promise<void> | null = null;

	async #scanDir(dir: string): Promise<void> {
		const seen = new Set<string>();
		let skipped = 0;
		const upsert = this.#db.prepare(
			"INSERT INTO idx_files (path, mtime, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime = excluded.mtime, size = excluded.size",
		);
		const insertFts = this.#db.prepare("INSERT INTO idx_fts (path, content, expanded) VALUES (?, ?, ?)");
		const updateContent = this.#db.prepare("UPDATE idx_fts SET content = ?, expanded = ? WHERE path = ?");
		const deleteRow = this.#db.prepare("DELETE FROM idx_files WHERE path = ?");
		const deleteFts = this.#db.prepare("DELETE FROM idx_fts WHERE path = ?");

		let files = 0;
		let tx = 0;

		// COMMIT the current batch and open a fresh transaction. Callers
		// must re-run BEGIN themselves (a dangling open transaction makes
		// the next scan's BEGIN throw "within a transaction").
		const commit = (): void => {
			this.#db.run("COMMIT");
		};

		const walk = async (abs: string): Promise<void> => {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(abs, { withFileTypes: true });
			} catch {
				return; // unreadable — skip silently
			}
			for (const ent of entries) {
				if (files >= MAX_FILES) {
					this.#truncated = true;
					return;
				}
				const p = path.join(abs, ent.name);
				if (ent.isDirectory()) {
					if (!SKIP_DIRS.has(ent.name)) await walk(p);
					continue;
				}
				if (!ent.isFile()) continue;
				const ext = path.extname(ent.name).toLowerCase();
				if (SKIP_EXT.has(ext)) continue;
				seen.add(p);
				files++;
				try {
					const st = await fs.promises.stat(p);
					if (st.size > MAX_FILE_BYTES) {
						skipped++;
						continue;
					}
					const existing = this.#db.query("SELECT mtime, size FROM idx_files WHERE path = ?").get(p) as
						| { mtime: number; size: number }
						| undefined;
					if (existing && existing.mtime === st.mtimeMs && existing.size === st.size) {
						continue; // unchanged
					}
					const buf = await fs.promises.readFile(p);
					if (buf.includes(0)) {
						skipped++;
						continue; // binary
					}
					const text = buf.toString("utf8");
					if (existing) {
						updateContent.run(text, expandCjk(text), p);
						upsert.run(p, st.mtimeMs, st.size);
					} else {
						insertFts.run(p, text, expandCjk(text));
						upsert.run(p, st.mtimeMs, st.size);
					}
					if (++tx >= 500) {
						commit();
						this.#db.run("BEGIN");
					}
				} catch {
					// unreadable/vanished mid-scan — skip
				}
			}
		};

		this.#db.run("BEGIN");
		try {
			await walk(dir);
			if (tx > 0) commit();
			else this.#db.run("COMMIT");
		} catch {
			try {
				this.#db.run("ROLLBACK");
			} catch {
				// already committed
			}
		}

		// Drop rows whose files disappeared since the last scan (chunked —
		// SQLite binds at most 999 params per statement).
		const all = this.#db.query("SELECT path FROM idx_files").all() as { path: string }[];
		const gone = all.filter(r => !seen.has(r.path));
		if (gone.length > 0) {
			const chunkSize = 400;
			for (let i = 0; i < gone.length; i += chunkSize) {
				const chunk = gone.slice(i, i + chunkSize);
				const placeholders = chunk.map(() => "?").join(",");
				this.#db.query(`DELETE FROM idx_files WHERE path IN (${placeholders})`).run(...chunk.map(r => r.path));
				this.#db.query(`DELETE FROM idx_fts WHERE path IN (${placeholders})`).run(...chunk.map(r => r.path));
			}
		}

		this.#files = (this.#db.query("SELECT COUNT(*) AS n FROM idx_files").get() as { n: number }).n;
		this.#skipped += skipped;
	}

	/** FTS5 prefix search over indexed file contents (snippet from the
	 *  original content column; matching on the bigram-expanded column). */
	search(query: string, limit = 30): IndexHit[] {
		if (!query.trim()) return [];
		try {
			const rows = this.#db
				.query(
					`SELECT path, snippet(idx_fts, 1, '\u0001', '\u0002', '…', 16) AS snip
					 FROM idx_fts WHERE expanded MATCH ? ORDER BY rank LIMIT ?`,
				)
				.all(indexQuery(query), limit) as { path: string; snip: string }[];
			return rows.map(r => ({ path: r.path, snippet: r.snip }));
		} catch {
			// Malformed query (e.g. bare `*`) — treat as no matches.
			return [];
		}
	}

	close(): void {
		try {
			this.#db.close();
		} catch {
			// already closed
		}
	}
}
