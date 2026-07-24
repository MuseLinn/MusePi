import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "../core/session-manager.ts";

interface CodexSessionRow {
	id: string;
	cwd: string;
	title: string;
	first_user_message: string;
	updated_at_ms: number;
	git_branch: string | null;
}

const CODEX_CONFIG_DIR = process.env.CODEX_CONFIG_DIR ?? join(homedir(), ".codex");

const STATE_DIR = join(CODEX_CONFIG_DIR, "state");

/**
 * Query a Codex state database for sessions matching a cwd.
 * Falls back to a simple `sqlite3` CLI call (must be on PATH).
 */
function queryCodexDb(dbPath: string, cwd: string): CodexSessionRow[] {
	const sql =
		"SELECT id, cwd, title, first_user_message, updated_at_ms, git_branch" +
		" FROM threads" +
		" WHERE archived = 0" +
		" AND cwd = ?" +
		" AND source IN ('cli', 'vscode')" +
		" ORDER BY updated_at_ms DESC";
	try {
		const output = execFileSync("sqlite3", ["-json", dbPath, sql, cwd], {
			encoding: "utf-8",
			timeout: 5000,
			stdio: ["pipe", "pipe", "ignore"],
		});
		if (!output.trim()) return [];
		return JSON.parse(output) as CodexSessionRow[];
	} catch {
		return [];
	}
}
function listCodexStateDbs(): string[] {
	let entries: string[];
	try {
		entries = readdirSync(STATE_DIR);
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.endsWith(".db"))
		.map((e) => join(STATE_DIR, e))
		.filter((p) => {
			try {
				return statSync(p).isFile();
			} catch {
				return false;
			}
		});
}

function mapRowToSessionInfo(row: CodexSessionRow, dbPath: string): SessionInfo {
	const millis =
		row.updated_at_ms < 1_577_836_800_000
			? row.updated_at_ms * 1000 // seconds → ms
			: row.updated_at_ms;
	const dt = new Date(millis);
	const title = row.title || row.first_user_message || "";

	return {
		path: dbPath,
		id: row.id,
		cwd: row.cwd,
		source: "codex" as const,
		name: title || undefined,
		created: dt,
		modified: dt,
		messageCount: 0, // not available from metadata query
		firstMessage: row.first_user_message || title || "",
		allMessagesText: "",
	};
}

/**
 * List Codex sessions matching the given cwd.
 */
export function listCodexSessions(cwd: string): SessionInfo[] {
	const dbs = listCodexStateDbs();
	const sessions: SessionInfo[] = [];
	for (const db of dbs) {
		const rows = queryCodexDb(db, cwd);
		for (const row of rows) {
			sessions.push(mapRowToSessionInfo(row, db));
		}
	}
	return sessions;
}

/**
 * List ALL Codex sessions from every cwd.
 */
export function listAllCodexSessions(): SessionInfo[] {
	const dbs = listCodexStateDbs();
	const sessions: SessionInfo[] = [];
	const sql = `SELECT id, cwd, title, first_user_message, updated_at_ms, git_branch
		FROM threads
		WHERE archived = 0
		AND source IN ('cli', 'vscode')
		ORDER BY updated_at_ms DESC`;
	for (const db of dbs) {
		try {
			const output = execFileSync("sqlite3", ["-json", db, sql], {
				encoding: "utf-8",
				timeout: 5000,
				stdio: ["pipe", "pipe", "ignore"],
			});
			if (output.trim()) {
				const rows = JSON.parse(output) as CodexSessionRow[];
				for (const row of rows) {
					sessions.push(mapRowToSessionInfo(row, db));
				}
			}
		} catch {}
	}
	return sessions;
}
