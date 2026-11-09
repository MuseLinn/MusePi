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

/**
 * Workspace-tree entries across every working directory of a session.
 *
 * `workspace.tree` reports paths relative to the root it scanned. Entries from
 * additional roots therefore carry an absolute `insertPath`; inserting the
 * relative path would resolve against the session's primary cwd and point at
 * the wrong file.
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
			const response = await rpc
				.request<{ entries?: TreeEntry[] }>("workspace.tree", {
					cwd: root,
					maxDepth: 3,
					perDirLimit: 100,
				})
				.catch(() => null);
			return { root, entries: response?.entries ?? [] };
		}),
	);

	const out: AtCompletionEntry[] = [];
	const seen = new Set<string>();
	for (const { root, entries } of scanned) {
		const isPrimary = primary.length > 0 && directoriesEqual(root, primary);
		const rootLabel = isPrimary ? undefined : pathBaseName(root);
		for (const entry of entries) {
			const insertPath = isPrimary ? undefined : `${root.replace(/[\\/]+$/, "")}/${entry.path}`;
			const key = insertPath ?? entry.path;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({
				name: entry.name,
				path: entry.path,
				isDir: entry.isDir,
				depth: entry.depth,
				insertPath,
				rootLabel,
			});
			if (out.length >= MAX_COMPLETION_ENTRIES) return out;
		}
	}
	return out;
}
