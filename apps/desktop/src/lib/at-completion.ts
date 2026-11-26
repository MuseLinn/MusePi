import { pathBaseName } from "./project-label";
import { directoriesEqual } from "./workspace-projects";

/** One "@" file completion row. */
export interface AtCompletionEntry {
	name: string;
	path: string;
	isDir: boolean;
	depth: number;
	/** Absolute path inserted into the composer for non-primary roots. */
	insertPath?: string;
	/** Basename of the owning root, shown as a badge for additional roots. */
	rootLabel?: string;
	/** The path only appears when `.gitignore` is not consulted. */
	ignored?: boolean;
}

/**
 * One "@" candidate: a file from the workspace tree, or a session the reader
 * wants to reference.
 *
 * Files and sessions share the menu because "@" is one gesture — "pull that
 * thing in" — and the reader should not have to remember which sigil reaches
 * which kind. A session row inserts `history://<id>` instead of a path, which
 * the read tool resolves to that session's transcript.
 */
export type AtCandidate =
	| ({ kind: "file" } & AtCompletionEntry)
	| {
			kind: "session";
			/** Session id — the value inserted as `history://<id>`. */
			id: string;
			/** Display title (the session's name, else its first prompt). */
			name: string;
			/** Directory the session ran in, shown as the trailing column. */
			cwd?: string;
			/** Last activity, ISO string; drives the within-group order. */
			updatedAt?: string;
			/** Directory name of the owning workspace, for the meta line. */
			workspaceName?: string;
	  };

/** Group headings the "@" menu renders, in menu order. */
export type AtCandidateGroup = "session" | "file";

export function atCandidateGroup(candidate: AtCandidate): AtCandidateGroup {
	return candidate.kind === "session" ? "session" : "file";
}

/**
 * Rank one candidate against the query, lower being better. Sessions and
 * files rank independently — a query that names a session title should not be
 * outranked by a file that merely contains the same substring.
 */
function atMatchRank(candidate: AtCandidate, query: string): number {
	if (query === "") return 0;
	const name = candidate.name.toLowerCase();
	if (name === query) return 0;
	if (name.startsWith(query)) return 1;
	if (name.includes(query)) return 2;
	const path = (candidate.kind === "session" ? (candidate.cwd ?? "") : candidate.path).toLowerCase();
	if (path.includes(query)) return 3;
	return 4;
}

/** Whether a candidate survives the query at all. */
function atMatches(candidate: AtCandidate, query: string): boolean {
	if (query === "") return true;
	if (candidate.kind === "session") {
		return (
			candidate.name.toLowerCase().includes(query) ||
			(candidate.cwd ?? "").toLowerCase().includes(query) ||
			candidate.id.toLowerCase().includes(query)
		);
	}
	return candidate.name.toLowerCase().includes(query) || candidate.path.toLowerCase().includes(query);
}

/**
 * Order the "@" list: sessions first (referencing another conversation is a
 * rarer, more deliberate act than picking a file, so it should not sit below
 * a hundred tree entries), each group ranked by match quality and then by
 * recency.
 */
export function rankAtCandidates(candidates: readonly AtCandidate[], query: string): AtCandidate[] {
	const q = query.trim().toLowerCase();
	const matched = candidates.filter(candidate => atMatches(candidate, q));
	return matched.sort((a, b) => {
		const byGroup = atCandidateGroup(a) === atCandidateGroup(b) ? 0 : atCandidateGroup(a) === "session" ? -1 : 1;
		if (byGroup !== 0) return byGroup;
		const byRank = atMatchRank(a, q) - atMatchRank(b, q);
		if (byRank !== 0) return byRank;
		if (a.kind === "session" && b.kind === "session") {
			return Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? "") || 0;
		}
		if (a.kind === "file" && b.kind === "file") {
			if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
			if (a.isDir !== b.isDir) return a.isDir ? 1 : -1;
		}
		return 0;
	});
}

interface TreeEntry {
	name: string;
	path: string;
	isDir: boolean;
	depth: number;
}

interface CompletionRpc {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** Roots are capped so a project with many mounts cannot stall completion. */
const MAX_COMPLETION_ROOTS = 8;
/** Entries are capped for the same reason; the menu is a picker, not a tree. */
const MAX_COMPLETION_ENTRIES = 400;

async function scanTree(rpc: CompletionRpc, root: string, gitignore: boolean): Promise<TreeEntry[]> {
	const response = await rpc
		.request<{ entries?: TreeEntry[] }>("workspace.tree", {
			cwd: root,
			maxDepth: 3,
			perDirLimit: 100,
			gitignore,
		})
		.catch(() => null);
	return response?.entries ?? [];
}

/**
 * Workspace-tree entries across every working directory of a session.
 *
 * `workspace.tree` reports paths relative to the root it scanned. Entries from
 * additional roots therefore carry an absolute `insertPath`; inserting the
 * relative path would resolve against the session's primary cwd and point at
 * the wrong file.
 *
 * Two scans per root keep ignored files available without losing the
 * non-ignored ranking: the filtered scan comes first, and paths that only the
 * unfiltered scan returns are appended with `ignored: true`.
 */
export async function loadAtCompletionEntries({
	rpc,
	cwd,
	sessionId,
	extraRoots = [],
}: {
	rpc: CompletionRpc;
	cwd?: string;
	sessionId?: string | null;
	/** Hosts without a live session can pass a project's remembered roots. */
	extraRoots?: readonly string[];
}): Promise<AtCompletionEntry[]> {
	const primary = cwd?.trim() ?? "";
	const roots: string[] = primary.length > 0 ? [primary] : [];
	const addRoot = (path: string): void => {
		if (path.length === 0) return;
		if (!roots.some(existing => directoriesEqual(existing, path))) roots.push(path);
	};
	if (sessionId) {
		const list = await rpc
			.request<{ directories?: Array<{ path?: string }> }>("session.directories.list", { sessionId })
			.catch(() => null);
		for (const directory of list?.directories ?? []) {
			if (typeof directory.path === "string") addRoot(directory.path);
		}
	}
	for (const root of extraRoots) addRoot(root);
	if (roots.length === 0) return [];

	const scanned = await Promise.all(
		roots.slice(0, MAX_COMPLETION_ROOTS).map(async root => {
			const [visible, all] = await Promise.all([scanTree(rpc, root, true), scanTree(rpc, root, false)]);
			return { root, visible, all };
		}),
	);

	const out: AtCompletionEntry[] = [];
	const seen = new Set<string>();
	for (const { root, visible, all } of scanned) {
		const isPrimary = primary.length > 0 && directoriesEqual(root, primary);
		const rootLabel = isPrimary ? undefined : pathBaseName(root);
		const visiblePaths = new Set(visible.map(entry => entry.path));
		const push = (entry: TreeEntry, ignored: boolean): boolean => {
			const insertPath = isPrimary ? undefined : `${root.replace(/[\\/]+$/, "")}/${entry.path}`;
			const key = insertPath ?? entry.path;
			if (seen.has(key)) return false;
			seen.add(key);
			out.push({
				name: entry.name,
				path: entry.path,
				isDir: entry.isDir,
				depth: entry.depth,
				insertPath,
				rootLabel,
				...(ignored ? { ignored: true } : {}),
			});
			return out.length >= MAX_COMPLETION_ENTRIES;
		};
		for (const entry of visible) {
			if (push(entry, false)) return out;
		}
		for (const entry of all) {
			if (visiblePaths.has(entry.path)) continue;
			if (push(entry, true)) return out;
		}
	}
	return out;
}

function matchRank(entry: AtCompletionEntry, query: string): number {
	const name = entry.name.toLowerCase();
	const path = entry.path.toLowerCase();
	if (name === query || path === query) return 0;
	if (name.startsWith(query)) return 1;
	if (path.startsWith(query)) return 2;
	if (path.includes(query)) return 3;
	return 4;
}

/**
 * Order already-filtered rows by match quality: exact and prefix hits first,
 * then non-ignored before ignored, then files before directories. The sort is
 * stable, so rows with the same rank keep the scan's recency order.
 */
export function rankAtCompletionEntries(entries: readonly AtCompletionEntry[], query: string): AtCompletionEntry[] {
	const q = query.trim().toLowerCase();
	if (q === "") return [...entries];
	return [...entries].sort((a, b) => {
		const byRank = matchRank(a, q) - matchRank(b, q);
		if (byRank !== 0) return byRank;
		if (a.ignored !== b.ignored) return a.ignored ? 1 : -1;
		if (a.isDir !== b.isDir) return a.isDir ? 1 : -1;
		return 0;
	});
}
