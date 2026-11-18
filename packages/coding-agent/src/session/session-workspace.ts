import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Filesystem workspace of a session: one current/default directory plus a
 * non-empty ordered list of workspace directories.
 *
 * `cwd` remains the default directory for relative-path resolution and
 * backward compatibility. `directories` always contains `cwd` first, followed
 * by any additional directories in their supplied order (deduplicated).
 * Directory order is stable but carries no semantic hierarchy.
 *
 * Workspace directories come from the platform (ACP/editor), CLI, or config —
 * never from filesystem walk-up discovery.
 */
export interface SessionWorkspace {
	/** Current/default directory for compatibility and relative path resolution. */
	cwd: string;
	/** Non-empty ordered list of absolute normalized directories; `cwd` is always first. */
	directories: string[];
}

/** Expand a leading `~`/`~/` and resolve to an absolute path (relative input resolves against `base`). */
export function normalizeWorkspaceDirectory(directory: string, base?: string): string {
	let expanded = directory;
	if (expanded === "~") {
		expanded = os.homedir();
	} else if (expanded.startsWith("~/") || expanded.startsWith(`~${path.sep}`)) {
		expanded = path.join(os.homedir(), expanded.slice(2));
	}
	return base ? path.resolve(base, expanded) : path.resolve(expanded);
}

/**
 * Build a normalized {@link SessionWorkspace} from a cwd and optional
 * additional directories. Additional entries are normalized (relative entries
 * resolve against the normalized cwd), deduplicated, and appended after `cwd`
 * preserving their supplied order.
 */
export function normalizeSessionWorkspace(args: { cwd: string; directories?: string[] }): SessionWorkspace {
	const cwd = normalizeWorkspaceDirectory(args.cwd);
	const directories = [cwd];
	for (const directory of args.directories ?? []) {
		const normalized = normalizeWorkspaceDirectory(directory, cwd);
		if (!directories.includes(normalized)) directories.push(normalized);
	}
	return { cwd, directories };
}

/** The workspace directories beyond `cwd`, in order (ACP `additionalDirectories` shape). */
export function additionalWorkspaceDirectories(workspace: SessionWorkspace): string[] {
	return workspace.directories.filter(directory => directory !== workspace.cwd);
}

/** Maximum number of secondary workspace roots beyond the primary directory. */
export const MAX_WORKSPACE_DIRECTORIES = 64;

/**
 * Additional roots must not be the user's home or a filesystem root: the agent
 * gains read/write reach into them, and one mistaken pick would expose every
 * unrelated project at once. The primary root is exempt — opening a home
 * directory as a project stays a deliberate choice. Symlinks are resolved
 * first so `~/link-to-home` cannot bypass the check.
 *
 * Lives here rather than with the daemon's directory RPCs so an importer can
 * apply the same rule without depending on a host service.
 */
export async function isSafeAdditionalDirectory(directory: string): Promise<boolean> {
	const real = await fs.realpath(directory).catch(() => directory);
	const forbidden = comparisonKey(real);
	return forbidden !== comparisonKey(os.homedir()) && forbidden !== comparisonKey(path.parse(real).root);
}

function comparisonKey(directory: string): string {
	const resolved = path.resolve(directory);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
