/**
 * Session listing logic for `musepi sessions`.
 *
 * Reuses the on-disk session scanner (`listAllSessions`) so the CLI rows match
 * what the TUI picker and the GUI welcome screen show. Pure functions only —
 * stdout writes go through the injected sink so tests can capture rows.
 */

import * as path from "node:path";
import { listAllSessions, type SessionInfo } from "../session/session-listing";
import { FileSessionStorage } from "../session/session-storage";

export interface SessionsCommandArgs {
	/** Only list sessions whose recorded cwd equals/descends from this path. */
	cwd?: string;
	/** Include archived sessions (sessions are not archived today; reserved flag). */
	archived?: boolean;
	/** Print at most n sessions (newest first). */
	limit?: number;
	/** Emit machine-readable JSON rows instead of the table. */
	json?: boolean;
}

export interface SessionsListDeps {
	readonly cwd: () => string;
	readonly stdout: { write(chunk: string): boolean };
	readonly stderr: { write(chunk: string): boolean };
	/** Injectable session scanner (defaults to the real on-disk listing). */
	readonly list?: () => Promise<SessionInfo[]>;
}

/** Resolve the listing options from parsed CLI args. */
export function resolveSessionsArgs(args: SessionsCommandArgs, cwd: string): SessionsCommandArgs {
	return { ...args, cwd: args.cwd ? path.resolve(args.cwd) : cwd };
}

/**
 * List sessions across every project scope, newest first, and write the rows
 * to stdout (text table or JSON). Returns the number of rows written.
 */
export async function runSessionsList(
	options: SessionsCommandArgs,
	deps: SessionsListDeps = { cwd: () => process.cwd(), stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
	const { stdout, list } = deps;
	const scopeCwd = options.cwd ? path.resolve(options.cwd) : deps.cwd();
	const all = await (list ?? (() => listAllSessions(new FileSessionStorage())))();
	// listAllSessions already sorts newest-first, but an injected list (or a
	// future scanner) must not be able to break the documented row order.
	all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	const filtered = options.cwd ? all.filter(session => session.cwd && path.resolve(session.cwd) === scopeCwd) : all;
	const limited = options.limit === undefined ? filtered : filtered.slice(0, options.limit);

	if (options.json) {
		stdout.write(`${JSON.stringify(limited.map(toJsonRow), null, 2)}\n`);
		return limited.length;
	}

	if (limited.length === 0) {
		stdout.write("No sessions found.\n");
		return 0;
	}

	for (const session of limited) {
		stdout.write(`${formatSessionRow(session)}\n`);
	}
	return limited.length;
}

interface SessionJsonRow {
	id: string;
	title: string;
	cwd: string;
	created: string;
	modified: string;
	status?: string;
	messageCount: number;
}

function toJsonRow(session: SessionInfo): SessionJsonRow {
	return {
		id: session.id,
		title: sanitizeField(session.title ?? session.firstMessage ?? ""),
		cwd: sanitizeField(session.cwd),
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		...(session.status ? { status: session.status } : {}),
		messageCount: session.messageCount,
	};
}

/** One text row: `<modified>  <id>  <title>  <cwd>`. */
function formatSessionRow(session: SessionInfo): string {
	const modified = formatTimestamp(session.modified.getTime());
	const title = truncateField(sanitizeField(session.title ?? session.firstMessage ?? "(no title)"), 60);
	const id = session.id.slice(0, 12);
	const cwd = sanitizeField(session.cwd);
	return `${modified}  ${id}  ${title}${cwd ? `  ${cwd}` : ""}`;
}

function formatTimestamp(epochMs: number): string {
	const date = new Date(epochMs);
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function sanitizeField(value: string): string {
	return value.replaceAll(/[\x00-\x1f\x7f]+/g, " ").trim();
}

function truncateField(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}
