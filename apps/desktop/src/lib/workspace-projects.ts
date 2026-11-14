import type { SessionDirectoryInfo, WorkspaceDuplicateDirectory, WorkspaceProject } from "@musepi/pi-wire";

/**
 * Project registry + session workspace RPC surface for the GUI.
 *
 * The daemon owns both stores (`workspace.*` reads/writes
 * `<config>/projects.json`; `session.directories.*` edits the live session
 * header), so this module only maps request shapes and the one-time
 * localStorage migration. Nothing here caches: the sidebar reloads after
 * every mutation and the daemon is the single source of truth.
 */

/** Structural request surface so tests can stub RPC without a live socket. */
export interface WorkspaceRpc {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/** Minimal storage surface (`localStorage` in the app, a Map in tests). */
export interface WorkspaceStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

export interface WorkspaceMutationResult {
	workspace: WorkspaceProject;
	duplicates: WorkspaceDuplicateDirectory[];
}

export interface SessionDirectoryMutation {
	added: boolean;
	/** The normalized directory that was added, or null for a duplicate. */
	directory: string | null;
	directories: SessionDirectoryInfo[];
	duplicate: WorkspaceDuplicateDirectory | null;
}

/** Legacy project list written by the pre-registry sidebar. */
export const LEGACY_PROJECTS_KEY = "musepi-gui-projects";
/** Legacy tombstones for projects the user removed explicitly. */
export const LEGACY_DISMISSED_KEY = "musepi-gui-projects-dismissed";
/** Set once the legacy list has been imported, so a mirror write never re-imports. */
export const LEGACY_MIGRATION_KEY = "musepi-gui-projects-migrated";

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Compare two directories the way the daemon normalizes them: separators and
 * Windows drive casing do not distinguish two roots, and neither does a
 * trailing slash. Not a full case-insensitive comparison on POSIX.
 */
export function directoriesEqual(left: string, right: string): boolean {
	const normalize = (value: string): string => {
		const slashed = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
		if (!WINDOWS_ABSOLUTE.test(value) && !value.startsWith("\\\\")) return slashed;
		// Windows and UNC paths are case-insensitive as a whole, not only on the
		// drive letter.
		return slashed.toLowerCase();
	};
	return normalize(left) === normalize(right);
}

function stringList(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
	} catch {
		return [];
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Projects registered with the daemon, newest-first, including implicit rows
 * backfilled from session cwds.
 */
export async function listProjects(rpc: WorkspaceRpc): Promise<WorkspaceProject[]> {
	const result = await rpc.request<{ workspaces?: WorkspaceProject[] }>("workspace.list", {});
	return Array.isArray(result?.workspaces) ? result.workspaces : [];
}

/** Register (or promote) a project. The daemon merges an existing root. */
export function createProject(
	rpc: WorkspaceRpc,
	root: string,
	name?: string,
	additionalDirs?: readonly string[],
): Promise<WorkspaceMutationResult> {
	return rpc.request<WorkspaceMutationResult>("workspace.create", {
		root,
		...(name === undefined ? {} : { name }),
		...(additionalDirs === undefined ? {} : { additionalDirs: [...additionalDirs] }),
	});
}

export function renameProject(rpc: WorkspaceRpc, id: string, name: string): Promise<WorkspaceMutationResult> {
	return rpc.request<WorkspaceMutationResult>("workspace.update", { id, name });
}

/** Rename and/or replace the whole additional-directory set in one call. */
export function updateProject(
	rpc: WorkspaceRpc,
	id: string,
	patch: { name?: string; additionalDirs?: readonly string[] },
): Promise<WorkspaceMutationResult> {
	return rpc.request<WorkspaceMutationResult>("workspace.update", {
		id,
		...(patch.name === undefined ? {} : { name: patch.name }),
		...(patch.additionalDirs === undefined ? {} : { additionalDirs: [...patch.additionalDirs] }),
	});
}

/** Unregister a project; on-disk content is untouched. */
export async function deleteProject(rpc: WorkspaceRpc, id: string): Promise<boolean> {
	const result = await rpc.request<{ deleted?: boolean }>("workspace.delete", { id });
	return result?.deleted === true;
}

export function setProjectPrimary(rpc: WorkspaceRpc, id: string, directory: string): Promise<WorkspaceProject> {
	return rpc
		.request<{ workspace: WorkspaceProject }>("workspace.setPrimary", { id, path: directory })
		.then(result => result.workspace);
}

/**
 * `workspace.update` replaces the whole additional-directory set, so the
 * caller passes the current set plus the new directory. A directory already
 * present (or equal to the primary root) is not an error: the daemon reports
 * it through `duplicates` and leaves the set unchanged.
 */
export function addProjectDirectory(
	rpc: WorkspaceRpc,
	project: Pick<WorkspaceProject, "id" | "additionalDirs">,
	directory: string,
): Promise<WorkspaceMutationResult> {
	return rpc.request<WorkspaceMutationResult>("workspace.update", {
		id: project.id,
		additionalDirs: [...project.additionalDirs, directory],
	});
}

export function removeProjectDirectory(
	rpc: WorkspaceRpc,
	project: Pick<WorkspaceProject, "id" | "additionalDirs">,
	directory: string,
): Promise<WorkspaceMutationResult> {
	return rpc.request<WorkspaceMutationResult>("workspace.update", {
		id: project.id,
		additionalDirs: project.additionalDirs.filter(existing => !directoriesEqual(existing, directory)),
	});
}

/** Working directories of a live session, primary first. */
export async function listSessionDirectories(rpc: WorkspaceRpc, sessionId: string): Promise<SessionDirectoryInfo[]> {
	const result = await rpc.request<{ directories?: SessionDirectoryInfo[] }>("session.directories.list", {
		sessionId,
	});
	return Array.isArray(result?.directories) ? result.directories : [];
}

export function addSessionDirectory(
	rpc: WorkspaceRpc,
	sessionId: string,
	directory: string,
): Promise<SessionDirectoryMutation> {
	return rpc.request<SessionDirectoryMutation>("session.directories.add", { sessionId, directory });
}

export async function removeSessionDirectory(
	rpc: WorkspaceRpc,
	sessionId: string,
	directory: string,
): Promise<SessionDirectoryInfo[]> {
	const result = await rpc.request<{ directories?: SessionDirectoryInfo[] }>("session.directories.remove", {
		sessionId,
		directory,
	});
	return Array.isArray(result?.directories) ? result.directories : [];
}

export interface LegacyMigrationResult {
	/** Roots registered by the import. */
	imported: string[];
	/** Roots skipped because the directory no longer exists. */
	skipped: string[];
	/** Roots that failed for another reason; the legacy list is kept. */
	failed: string[];
	/** True when the legacy keys were consumed. */
	migrated: boolean;
}

/**
 * Import the pre-registry `musepi-gui-projects` list once.
 *
 * Explicitly removed projects (the dismissed tombstones) stay out, missing
 * directories are skipped instead of failing the run, and any other failure
 * keeps both legacy keys so the next mount retries and the caller can tell the
 * user why. Availability is probed with `fs.stat` first because
 * `workspace.create` rejects a missing directory forever otherwise.
 */
export async function migrateLegacyProjects(
	rpc: WorkspaceRpc,
	storage: WorkspaceStorage = localStorage,
): Promise<LegacyMigrationResult> {
	const empty: LegacyMigrationResult = { imported: [], skipped: [], failed: [], migrated: false };
	if (storage.getItem(LEGACY_MIGRATION_KEY) === "1") return { ...empty, migrated: true };
	const dismissed = stringList(storage.getItem(LEGACY_DISMISSED_KEY));
	const roots = stringList(storage.getItem(LEGACY_PROJECTS_KEY)).filter(
		root => root.length > 0 && !dismissed.some(removed => directoriesEqual(removed, root)),
	);
	const seen: string[] = [];
	const result: LegacyMigrationResult = { imported: [], skipped: [], failed: [], migrated: false };
	for (const root of roots) {
		if (seen.some(existing => directoriesEqual(existing, root))) continue;
		seen.push(root);
		try {
			const stat = await rpc.request<{ exists?: boolean }>("fs.stat", { path: root });
			if (stat?.exists === false) {
				result.skipped.push(root);
				continue;
			}
			await createProject(rpc, root);
			result.imported.push(root);
		} catch (error) {
			// Keep the legacy list: a transport failure must not lose the user's
			// projects, and a retry should import the rest on the next mount.
			result.failed.push(`${root}: ${errorText(error)}`);
		}
	}
	if (result.failed.length > 0) return result;
	storage.removeItem(LEGACY_PROJECTS_KEY);
	storage.removeItem(LEGACY_DISMISSED_KEY);
	storage.setItem(LEGACY_MIGRATION_KEY, "1");
	return { ...result, migrated: true };
}

/**
 * Rewrite the legacy key as a derived mirror of the registry.
 *
 * `WelcomeComposer`, the PR board and the scheduled-task page still read this
 * key; the projects tab never reads it back (the migration marker blocks
 * re-import), so the mirror is output-only and cannot become a second source
 * of truth. Skipped until the migration consumed the key, so an unimported
 * list is never overwritten.
 */
export function mirrorProjects(storage: WorkspaceStorage, projects: readonly WorkspaceProject[]): void {
	if (storage.getItem(LEGACY_MIGRATION_KEY) !== "1") return;
	try {
		storage.setItem(LEGACY_PROJECTS_KEY, JSON.stringify(projects.map(project => project.root)));
	} catch {
		// Storage unavailable (private mode): the sidebar does not depend on it.
	}
}
