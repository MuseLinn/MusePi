/**
 * Protocol handler for artifact:// URLs.
 *
 * Resolves artifact IDs against session artifacts directories. Unlike
 * agent://, artifacts are raw text with no JSON extraction.
 *
 * URL forms:
 * - artifact://<id> - Full artifact content of the calling session, falling
 *   back to the artifacts dirs of every registered session in registry order.
 * - artifact://<sessionId>/<id> - Full artifact content of the named session,
 *   where `sessionId` is that session's file basename without `.jsonl`. The
 *   name pins the session explicitly, so the URL stays readable across
 *   sessions, devices, and hosts that share a sessions root instead of
 *   resolving against whichever artifacts dir happens to be registered first.
 *
 * Pagination is handled by the read tool via offset/limit parameters.
 */
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir, isEnoent } from "@musepi/pi-utils";
import { ARTIFACT_SESSION_ID_RE } from "@musepi/pi-wire";
import { artifactsDirsFromRegistry } from "./registry-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const MAX_INLINE_ARTIFACT_BYTES = 8 * 1024 * 1024;
/**
 * Bounds for named-session lookup: workspace slugs probed under the sessions
 * root, and subagent artifact dirs probed inside one session dir. Both keep a
 * single URL resolution from scanning an unbounded tree.
 */
const MAX_WORKSPACE_DIRS = 256;
const MAX_ARTIFACT_SUBDIRS = 128;

/** Filesystem location for a session artifact, resolved without materializing its content. */
export interface ResolvedArtifactFile {
	id: string;
	path: string;
	size: number;
}

interface ArtifactTarget {
	/** Null for the caller-scoped `artifact://<id>` form. */
	sessionId: string | null;
	id: string;
}

/**
 * The session id is joined into a filesystem path below the sessions root, so
 * this validation is the only boundary preventing traversal: no separators, no
 * `.`/`..`, and no dot-prefixed escape names.
 */
function parseSessionId(raw: string): string {
	if (!ARTIFACT_SESSION_ID_RE.test(raw) || raw === "." || raw === ".." || raw.startsWith(".")) {
		throw new Error(
			`Invalid artifact session ID: ${raw}. Expected a session file name made of letters, digits, ".", "_" and "-", without path separators.`,
		);
	}
	return raw;
}

function parseArtifactTarget(url: InternalUrl): ArtifactTarget {
	const host = url.rawHost || url.hostname;
	if (!host) {
		throw new Error("artifact:// URL requires a numeric ID: artifact://0");
	}
	const pathname = url.rawPathname ?? url.pathname;
	if (pathname === "" || pathname === "/") {
		if (/^\d+$/.test(host)) return { sessionId: null, id: host };
		if (pathname === "/") {
			throw new Error(`artifact://${parseSessionId(host)}/ requires a numeric artifact ID`);
		}
		throw new Error(`artifact:// ID must be numeric, got: ${host}`);
	}
	const sessionId = parseSessionId(host);
	const match = /^\/(\d+)$/.exec(pathname);
	if (!match) {
		throw new Error(
			`artifact://${sessionId}/ requires a numeric artifact ID with no extra path segments: artifact://${sessionId}/0`,
		);
	}
	return { sessionId, id: match[1] };
}

/** Selector base for guidance messages, preserving the URL's session scoping. */
function artifactSelectorBase(url: InternalUrl): string {
	const target = parseArtifactTarget(url);
	return target.sessionId ? `artifact://${target.sessionId}/${target.id}` : `artifact://${target.id}`;
}

/** A probe of an unreadable candidate reads as absent rather than failing resolution. */
async function readDirEntries(dir: string): Promise<Dirent[] | null> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return null;
	}
}

async function isDirectory(dir: string): Promise<boolean> {
	try {
		return (await fs.stat(dir)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Artifacts dirs for a named session, in lookup order. A session's artifacts
 * dir is its session file path without `.jsonl`: probe that name directly under
 * the sessions root and among live registrations first, then fall back to the
 * workspace-slug level where parked sessions live.
 */
async function resolveSessionDirs(sessionId: string): Promise<string[]> {
	const found: string[] = [];
	const add = async (dir: string | null | undefined): Promise<void> => {
		if (!dir || found.includes(dir)) return;
		if (await isDirectory(dir)) found.push(dir);
	};

	const sessionsRoot = getSessionsDir();
	await add(path.join(sessionsRoot, sessionId));
	for (const dir of artifactsDirsFromRegistry()) {
		if (path.basename(dir) === sessionId) await add(dir);
	}
	if (found.length > 0) return found;

	const workspaces = await readDirEntries(sessionsRoot);
	let probed = 0;
	for (const entry of workspaces ?? []) {
		if (probed >= MAX_WORKSPACE_DIRS) break;
		if (!entry.isDirectory()) continue;
		probed++;
		await add(path.join(sessionsRoot, entry.name, sessionId));
	}
	return found;
}

function matchArtifactEntry(entries: Dirent[], dir: string, id: string, availableIds: Set<string>): string | undefined {
	for (const entry of entries) {
		if (entry.isDirectory()) continue;
		if (entry.name.startsWith(`${id}.`)) return path.join(dir, entry.name);
		const match = /^(\d+)\./.exec(entry.name);
		if (match) availableIds.add(match[1]);
	}
	return undefined;
}

/**
 * Search one session's artifacts dirs: the session dir itself, then its direct
 * subdirectories, which hold subagent outputs (`<sessionFile>.jsonl` stripped,
 * then `<AgentId>/`).
 */
async function lookupSessionArtifact(
	sessionDirs: string[],
	id: string,
): Promise<{ foundPath?: string; availableIds: Set<string> }> {
	const availableIds = new Set<string>();
	for (const dir of sessionDirs) {
		const entries = await readDirEntries(dir);
		if (!entries) continue;
		const direct = matchArtifactEntry(entries, dir, id, availableIds);
		if (direct) return { foundPath: direct, availableIds };

		let probed = 0;
		for (const entry of entries) {
			if (probed >= MAX_ARTIFACT_SUBDIRS) break;
			if (!entry.isDirectory()) continue;
			probed++;
			const child = path.join(dir, entry.name);
			const childEntries = await readDirEntries(child);
			if (!childEntries) continue;
			const nested = matchArtifactEntry(childEntries, child, id, availableIds);
			if (nested) return { foundPath: nested, availableIds };
		}
	}
	return { availableIds };
}

async function resolveNamedSessionArtifact(sessionId: string, id: string): Promise<ResolvedArtifactFile> {
	const sessionDirs = await resolveSessionDirs(sessionId);
	if (sessionDirs.length === 0) {
		throw new Error(`Artifact session ${sessionId} not found`);
	}
	const { foundPath, availableIds } = await lookupSessionArtifact(sessionDirs, id);
	if (!foundPath) {
		const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
		const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
		throw new Error(`Artifact ${id} not found in session ${sessionId}. Available: ${availableStr}`);
	}
	const stat = await Bun.file(foundPath).stat();
	if (stat.isDirectory()) {
		throw new Error(`Artifact ${id} resolved to a directory, not a file`);
	}
	return { id, path: foundPath, size: stat.size };
}

/** Resolve an `artifact://` URL to its backing file without reading artifact bytes. */
export async function resolveArtifactFile(url: InternalUrl, context?: ResolveContext): Promise<ResolvedArtifactFile> {
	const target = parseArtifactTarget(url);
	if (target.sessionId) return resolveNamedSessionArtifact(target.sessionId, target.id);
	const id = target.id;

	// Artifact ids are per-session counters; in multi-session hosts the same
	// id exists in several dirs. Pin resolution to the calling session's
	// artifacts dir first so `artifact://3` means *this* session's #3.
	const dirs = artifactsDirsFromRegistry();
	const pinnedDir = context?.localProtocolOptions?.getArtifactsDir?.() ?? null;
	if (pinnedDir) {
		const pinnedIndex = dirs.indexOf(pinnedDir);
		if (pinnedIndex >= 0) dirs.splice(pinnedIndex, 1);
		dirs.unshift(pinnedDir);
	}

	if (dirs.length === 0) {
		throw new Error("No session - artifacts unavailable");
	}

	let foundPath: string | undefined;
	let anyDirExists = false;
	const availableIds = new Set<string>();

	for (const dir of dirs) {
		let files: string[];
		try {
			files = await fs.readdir(dir);
			anyDirExists = true;
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
		const match = files.find(f => f.startsWith(`${id}.`));
		if (match) {
			foundPath = path.join(dir, match);
			break;
		}
		for (const f of files) {
			const m = f.match(/^(\d+)\./);
			if (m) availableIds.add(m[1]);
		}
	}

	if (!anyDirExists) {
		throw new Error("No artifacts directory found");
	}

	if (!foundPath) {
		const sorted = [...availableIds].sort((a, b) => Number(a) - Number(b));
		const availableStr = sorted.length > 0 ? sorted.join(", ") : "none";
		throw new Error(`Artifact ${id} not found. Available: ${availableStr}`);
	}

	const stat = await Bun.file(foundPath).stat();
	if (stat.isDirectory()) {
		throw new Error(`Artifact ${id} resolved to a directory, not a file`);
	}
	return { id, path: foundPath, size: stat.size };
}

export class ArtifactProtocolHandler implements ProtocolHandler {
	readonly scheme = "artifact";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const artifact = await resolveArtifactFile(url, context);

		// Path-only callers (search/grep, bash URL expansion) never touch the
		// artifact bytes. Return the resource shape so those flows keep working
		// on artifacts of any size — only content materialization is gated.
		if (context?.pathOnly) {
			return {
				url: url.href,
				content: "",
				contentType: "text/plain",
				size: artifact.size,
				sourcePath: artifact.path,
			};
		}

		if (artifact.size > MAX_INLINE_ARTIFACT_BYTES) {
			const base = artifactSelectorBase(url);
			throw new Error(
				`Artifact ${artifact.id} is ${artifact.size} bytes; full internal resolution is blocked. Use read selectors such as ${base}:1-3000 or ${base}:raw:1-3000, and use the artifact file path for search/copy workflows: ${artifact.path}`,
			);
		}

		const content = await Bun.file(artifact.path).text();
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: artifact.size,
			sourcePath: artifact.path,
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		const ids = new Set<string>();
		for (const dir of artifactsDirsFromRegistry()) {
			let files: string[];
			try {
				files = await fs.readdir(dir);
			} catch (err) {
				if (isEnoent(err)) continue;
				throw err;
			}
			for (const f of files) {
				const m = f.match(/^(\d+)\./);
				if (m) ids.add(m[1]!);
			}
		}
		return [...ids].sort((a, b) => Number(a) - Number(b)).map(value => ({ value }));
	}
}
