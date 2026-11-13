/**
 * Subagent transcript identity: agent id, child session id, and the file that
 * carries both.
 *
 * A task subagent persists at `<parentSessionBase>/<agentId>.jsonl` (the task
 * executor builds it from `artifactsDir`, and {@link registerPersistedSubagents}
 * reads the same convention). The file name is the *instance* id the registry
 * and every RPC address; the transcript's own `session` header carries the
 * child session id `session.list` uses; `session_init.agent` names the agent
 * definition that ran it. Those three ids are not interchangeable, and the
 * registry only holds a ref while the child is live — so anything that reads a
 * finished subagent has to resolve the file from the parent's product directory
 * instead of from the registry.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Directory listing cache: transcript fetches poll, the registry usually
 *  misses, and the directory changes only when a child starts. */
const LISTING_TTL_MS = 2000;
/** Bounded so a pathological artifact directory cannot stall a poll. */
const MAX_LISTED_FILES = 2000;
/** Transcripts nest one level per generation (`<root>/<child>/<grandchild>`). */
const MAX_DEPTH = 2;

interface ListingEntry {
	at: number;
	files: readonly string[];
}

const listings = new Map<string, ListingEntry>();
const sessionIds = new Map<string, { mtimeMs: number; size: number; id: string | null }>();

/** `<session>.jsonl` → `<session>` : the product directory holding every
 *  descendant transcript. Null when the path is not a session file. */
export function sessionProductDir(sessionFile: string | null | undefined): string | null {
	if (!sessionFile?.endsWith(".jsonl")) return null;
	return sessionFile.slice(0, -".jsonl".length);
}

/** The instance id a transcript file is addressed by. */
export function transcriptAgentId(file: string): string {
	return path.basename(file, ".jsonl");
}

/** True when `file` lives inside `sessionFile`'s product directory. */
export function isSubagentTranscriptOf(sessionFile: string, file: string | null | undefined): boolean {
	const dir = sessionProductDir(sessionFile);
	if (!dir || !file) return false;
	const relative = path.relative(dir, file);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Reject anything that could escape the product directory. */
function isSafeAgentId(agentId: string): boolean {
	return (
		agentId.length > 0 &&
		agentId !== "." &&
		agentId !== ".." &&
		!agentId.includes("/") &&
		!agentId.includes("\\") &&
		!agentId.includes("\0")
	);
}

async function readTranscriptFiles(dir: string): Promise<readonly string[]> {
	const cached = listings.get(dir);
	if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.files;
	const files: string[] = [];
	const walk = async (current: string, depth: number): Promise<void> => {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= MAX_LISTED_FILES) return;
			const full = path.join(current, entry.name);
			if (entry.isFile()) {
				if (entry.name.endsWith(".jsonl") && !entry.name.includes(".bak")) files.push(full);
				continue;
			}
			// `local/` holds tool artifacts; transcript generations are the only
			// nested session directories we descend into.
			if (depth >= MAX_DEPTH || entry.name === "local" || entry.name === "node_modules") continue;
			await walk(full, depth + 1);
		}
	};
	await walk(dir, 0);
	listings.set(dir, { at: Date.now(), files });
	return files;
}

/** Child session id from a transcript's `session` header. Cheap (first window),
 *  stat-memoized, and null when the prefix is unreadable. */
export async function readTranscriptSessionId(file: string): Promise<string | null> {
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(file);
	} catch {
		return null;
	}
	const cached = sessionIds.get(file);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.id;
	let id: string | null = null;
	const handle = await fs.promises.open(file, "r").catch(() => null);
	if (handle) {
		try {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
			for (const line of buffer.subarray(0, bytesRead).toString("utf-8").split("\n")) {
				if (!line.startsWith("{")) continue;
				try {
					const record = JSON.parse(line) as { type?: unknown; id?: unknown };
					if (record.type === "session" && typeof record.id === "string") {
						id = record.id;
						break;
					}
				} catch {
					// A split or malformed line is not the header; keep looking.
				}
			}
		} finally {
			await handle.close();
		}
	}
	sessionIds.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, id });
	return id;
}

/**
 * Resolve a subagent transcript from its owning session: by agent id (file
 * name), or — when the caller only knows the child session id `session.list`
 * showed — by the transcript's own header. Null when neither matches; callers
 * must not fall back to a different child.
 */
export async function resolveSubagentTranscript(
	parentSessionFile: string | null | undefined,
	transcriptId: string,
): Promise<string | null> {
	const dir = sessionProductDir(parentSessionFile);
	if (!dir || !isSafeAgentId(transcriptId)) return null;
	const direct = path.join(dir, `${transcriptId}.jsonl`);
	if (await Bun.file(direct).exists()) return direct;
	const files = await readTranscriptFiles(dir);
	const byName = files.find(file => path.basename(file, ".jsonl") === transcriptId);
	if (byName) return byName;
	for (const file of files) {
		if (path.basename(file).startsWith("__advisor")) continue;
		if ((await readTranscriptSessionId(file)) === transcriptId) return file;
	}
	return null;
}
