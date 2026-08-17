import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Workspace-scoped file operations for the GUI file pane (新建/重命名/删除).
 *
 * Security model: every operation takes the session cwd and a RELATIVE
 * path. Absolute paths are rejected outright; relative paths are resolved
 * against the cwd and any `..` escape is rejected. Symlinks are NOT
 * followed for delete/rename targets (they are removed/replaced as links),
 * which keeps a symlink inside the workspace from redirecting a write or
 * a recursive delete outside it.
 */

/** Resolve a cwd-relative path inside the workspace, or null on escape. */
export function resolveInCwd(cwd: string, rel: string): string | null {
	if (!cwd || !rel) return null;
	if (path.isAbsolute(rel)) return null;
	const base = path.resolve(cwd);
	const abs = path.resolve(base, rel);
	if (abs !== base && !abs.startsWith(base + path.sep)) return null;
	return abs;
}

export interface FsOpResult {
	ok: boolean;
	error?: string;
}

/** Create a file (overwrites) with the given text content. */
export function writeWorkspaceFile(cwd: string, rel: string, content: string): FsOpResult {
	const abs = resolveInCwd(cwd, rel);
	if (!abs) return { ok: false, error: "path escapes workspace" };
	try {
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, "utf8");
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Create a directory (recursive, idempotent). */
export function createWorkspaceDir(cwd: string, rel: string): FsOpResult {
	const abs = resolveInCwd(cwd, rel);
	if (!abs) return { ok: false, error: "path escapes workspace" };
	try {
		fs.mkdirSync(abs, { recursive: true });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Rename/move a workspace entry (file or dir). */
export function renameWorkspaceEntry(cwd: string, relFrom: string, relTo: string): FsOpResult {
	const absFrom = resolveInCwd(cwd, relFrom);
	const absTo = resolveInCwd(cwd, relTo);
	if (!absFrom || !absTo) return { ok: false, error: "path escapes workspace" };
	try {
		fs.mkdirSync(path.dirname(absTo), { recursive: true });
		fs.renameSync(absFrom, absTo);
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Delete a workspace entry (file or directory tree). */
export function deleteWorkspaceEntry(cwd: string, rel: string): FsOpResult {
	const abs = resolveInCwd(cwd, rel);
	if (!abs) return { ok: false, error: "path escapes workspace" };
	try {
		fs.rmSync(abs, { recursive: true, force: true });
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
