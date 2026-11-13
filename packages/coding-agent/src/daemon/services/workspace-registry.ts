import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger } from "@musepi/pi-utils";
import type { SessionDirectoryInfo, WorkspaceDuplicateDirectory, WorkspaceProject } from "@musepi/pi-wire";
import { normalizeWorkspaceDirectory } from "../../session/session-workspace";
import type { DaemonService } from "./types";

/**
 * WorkspaceService — 持久化项目注册表 + 会话多工作目录 RPC（L2 宿主服务）。
 *
 * 能力缝声明（M2-2.4）：
 * - 名称+ns：`daemon/services/workspace-registry`，服务键 `workspaces`；
 *   路由 `workspace.list/create/update/delete/setPrimary` 与
 *   `session.directories.list/add/remove`。
 * - 输入：项目注册表写 `<config root>/projects.json`（跟随 `getConfigRootDir()`
 *   的 profile/XDG 解析，不硬编码 `~/.musepi`）；会话目录路由只作用于 live
 *   会话，经 `SessionManager.addWorkspaceDirectory` /
 *   `removeWorkspaceDirectory` 落会话头。
 * - 输出：`WorkspaceProject` 行（主目录 + additionalDirs + 时间戳）；目录
 *   变更返回结构化 `duplicates` 与变更后的目录清单。
 * - 生命周期：无进程内缓存——每次操作重读磁盘并在进程内串行队列里
 *   执行；写盘走同目录临时文件 + rename（崩溃不会留下半个 JSON）。
 * - 启停：always-on——注册表是 GUI 侧栏的常驻数据面，无独立启停语义。
 * - 冲突：路由唯一归属由 `HostServices.routeTable` 强制；隐式项目回填
 *   只补缺失的会话 cwd，已删除的 root 记入墓碑，重启后不会被会话历史复活。
 *
 * 目录契约：绝对化、去重（返回 `{ path, directory }`）、存在性校验、
 * additionalDirs 最多 {@link MAX_WORKSPACE_DIRECTORIES} 条。`cwd` 本身不是
 * additional 目录；setPrimary 把目标目录与旧主目录原子互换。
 */

/** Maximum number of secondary workspace roots beyond the primary directory. */
export const MAX_WORKSPACE_DIRECTORIES = 64;

const REGISTRY_VERSION = 1;
const REGISTRY_FILENAME = "projects.json";
const MAX_WORKSPACE_NAME = 100;

export type WorkspaceDirectoryErrorCode =
	| "WORKSPACE_DIRECTORY_NOT_FOUND"
	| "WORKSPACE_DIRECTORY_NOT_A_DIRECTORY"
	| "WORKSPACE_DIRECTORY_LIMIT"
	| "WORKSPACE_DIRECTORY_NOT_IN_WORKSPACE"
	| "WORKSPACE_DIRECTORY_UNSAFE";

/** Typed directory validation failure; `code` lets callers map the RPC error. */
export class WorkspaceDirectoryError extends Error {
	readonly code: WorkspaceDirectoryErrorCode;
	readonly directory?: string;

	constructor(code: WorkspaceDirectoryErrorCode, message: string, directory?: string) {
		super(message);
		this.name = "WorkspaceDirectoryError";
		this.code = code;
		this.directory = directory;
	}
}

export interface ResolvedWorkspaceDirectories {
	/** Normalized, existing, deduplicated directories (primary root excluded). */
	directories: string[];
	/** Caller inputs that resolved to a directory already in the set. */
	duplicates: WorkspaceDuplicateDirectory[];
}

export interface WorkspaceMutationResult {
	workspace: WorkspaceProject;
	duplicates: WorkspaceDuplicateDirectory[];
}

interface WorkspaceRegistryFile {
	version: number;
	projects: WorkspaceProject[];
	deletedRoots: string[];
	/** root → removal time. Kept after the same folder is registered again so
	 *  sessions from the removed workspace stay hidden (workspace identity is
	 *  the registration, not the path). */
	deletedRootTimes: Record<string, number>;
}

/** Removed-workspace evidence used to hide sessions from lists. */
export interface DeletedWorkspaces {
	/** Roots whose project row is currently absent. */
	readonly roots: ReadonlySet<string>;
	/** Roots removed at some point, with the removal time. */
	readonly deletedAt: Readonly<Record<string, number>>;
}

/**
 * Whether a session belongs to a removed workspace.
 *
 * A root that is currently removed hides every session in it. A root that was
 * removed and later registered again hides only the sessions that existed at
 * that removal, so folding a folder back never resurrects the old workspace's
 * history, while sessions created afterwards stay visible.
 */
export function sessionHiddenByWorkspace(
	cwd: string | undefined,
	createdAt: number,
	deleted: DeletedWorkspaces,
): boolean {
	if (!cwd) return false;
	let root: string;
	try {
		root = normalizeWorkspaceDirectory(cwd);
	} catch {
		return false;
	}
	if (deleted.roots.has(root)) return true;
	const removedAt = deleted.deletedAt[root];
	return removedAt !== undefined && createdAt <= removedAt;
}

async function requireDirectory(directory: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.stat(directory);
	} catch (err) {
		if (isEnoent(err)) {
			throw new WorkspaceDirectoryError(
				"WORKSPACE_DIRECTORY_NOT_FOUND",
				`Directory does not exist: ${directory}`,
				directory,
			);
		}
		throw err;
	}
	if (!stat.isDirectory()) {
		throw new WorkspaceDirectoryError(
			"WORKSPACE_DIRECTORY_NOT_A_DIRECTORY",
			`Path is not a directory: ${directory}`,
			directory,
		);
	}
}

function comparisonKey(directory: string): string {
	const resolved = path.resolve(directory);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Additional roots must not be the user's home or a filesystem root: the
 * agent gains read/write reach into them, and one mistaken pick would expose
 * every unrelated project (and every dotfile) at once. The primary root is
 * exempt — opening a home directory as a project stays a deliberate choice.
 * Symlinks are resolved first so `~/link-to-home` cannot bypass the check.
 */
async function requireSafeAdditionalDirectory(directory: string): Promise<void> {
	const real = await fs.realpath(directory).catch(() => directory);
	const forbidden = comparisonKey(real);
	const home = comparisonKey(homedir());
	const root = comparisonKey(path.parse(real).root);
	if (forbidden === home || forbidden === root) {
		throw new WorkspaceDirectoryError(
			"WORKSPACE_DIRECTORY_UNSAFE",
			`Directory cannot be an additional workspace root: ${directory}`,
			directory,
		);
	}
}

/** Non-throwing probe for inherited project roots: a stale unsafe entry must
 *  not block every new session. */
export async function isSafeAdditionalDirectory(directory: string): Promise<boolean> {
	try {
		await requireSafeAdditionalDirectory(directory);
		return true;
	} catch {
		return false;
	}
}

export async function workspaceDirectoryExists(directory: string): Promise<boolean> {
	try {
		return (await fs.stat(directory)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Normalize caller-supplied additional directories against `root`.
 *
 * Duplicates collapse into the returned report instead of failing: the GUI
 * shows "already added" inline rather than turning a no-op into an error.
 * Missing paths and non-directories fail with a typed error; the unique count
 * is capped at {@link MAX_WORKSPACE_DIRECTORIES}.
 */
export async function resolveWorkspaceDirectories(
	root: string,
	input: readonly unknown[],
): Promise<ResolvedWorkspaceDirectories> {
	const normalizedRoot = normalizeWorkspaceDirectory(root);
	const duplicates: WorkspaceDuplicateDirectory[] = [];
	const directories: string[] = [];
	const seen = new Set<string>([normalizedRoot]);
	for (const raw of input) {
		if (typeof raw !== "string" || raw.trim().length === 0) {
			throw new Error("Workspace directories must be non-empty strings.");
		}
		const value = raw.trim();
		const resolved = normalizeWorkspaceDirectory(value, normalizedRoot);
		if (seen.has(resolved)) {
			duplicates.push({ path: value, directory: resolved });
			continue;
		}
		await requireDirectory(resolved);
		await requireSafeAdditionalDirectory(resolved);
		seen.add(resolved);
		directories.push(resolved);
	}
	if (directories.length > MAX_WORKSPACE_DIRECTORIES) {
		throw new WorkspaceDirectoryError(
			"WORKSPACE_DIRECTORY_LIMIT",
			`A workspace can have at most ${MAX_WORKSPACE_DIRECTORIES} additional directories.`,
		);
	}
	return { directories, duplicates };
}

function normalizeWorkspaceName(name: unknown, fallback: string): string {
	if (name === undefined) return fallback;
	if (typeof name !== "string") throw new Error("Workspace name must be a string.");
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_WORKSPACE_NAME) {
		throw new Error(`Workspace name must be 1-${MAX_WORKSPACE_NAME} characters.`);
	}
	return trimmed;
}

function defaultWorkspaceName(root: string): string {
	const base = path.basename(root).trim();
	return base.length > 0 ? base : root;
}

/** Stable id for an implicit project: `wd_<slug>_<hash12>` derived from root. */
export function implicitWorkspaceId(root: string): string {
	const slug =
		path
			.basename(root)
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^[-.]+|[-.]+$/g, "")
			.slice(0, 24) || "root";
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
	return `wd_${slug}_${hash}`;
}

function emptyRegistry(): WorkspaceRegistryFile {
	return { version: REGISTRY_VERSION, projects: [], deletedRoots: [], deletedRootTimes: {} };
}

function sanitizeProject(value: unknown): WorkspaceProject | undefined {
	if (!value || typeof value !== "object") return undefined;
	const o = value as Record<string, unknown>;
	if (typeof o.id !== "string" || o.id.length === 0) return undefined;
	if (typeof o.root !== "string" || !path.isAbsolute(o.root)) return undefined;
	const root = normalizeWorkspaceDirectory(o.root);
	const kind = o.kind === "managed" || o.kind === "implicit" ? o.kind : "implicit";
	const additionalDirs = Array.isArray(o.additionalDirs)
		? [
				...new Set(
					o.additionalDirs
						.filter((d): d is string => typeof d === "string" && path.isAbsolute(d))
						.map(d => normalizeWorkspaceDirectory(d))
						.filter(d => d !== root),
				),
			].slice(0, MAX_WORKSPACE_DIRECTORIES)
		: [];
	const createdAt = typeof o.createdAt === "number" && Number.isFinite(o.createdAt) ? o.createdAt : 0;
	const lastOpenedAt =
		typeof o.lastOpenedAt === "number" && Number.isFinite(o.lastOpenedAt) ? o.lastOpenedAt : createdAt;
	const name = typeof o.name === "string" && o.name.trim().length > 0 ? o.name.trim() : defaultWorkspaceName(root);
	return { id: o.id, root, name, kind, additionalDirs, createdAt, lastOpenedAt };
}

/**
 * Collapse rows sharing a root: a managed row wins over an implicit one, then
 * the most recently opened row wins. Output is newest-first.
 */
function dedupeProjects(projects: readonly WorkspaceProject[]): WorkspaceProject[] {
	const byRoot = new Map<string, WorkspaceProject>();
	for (const project of projects) {
		const existing = byRoot.get(project.root);
		if (
			!existing ||
			(existing.kind === "implicit" && project.kind === "managed") ||
			(existing.kind === project.kind && project.lastOpenedAt > existing.lastOpenedAt)
		) {
			byRoot.set(project.root, project);
		}
	}
	return [...byRoot.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || a.id.localeCompare(b.id));
}

function parseRegistry(parsed: unknown): WorkspaceRegistryFile {
	if (!parsed || typeof parsed !== "object") return emptyRegistry();
	const o = parsed as Record<string, unknown>;
	const projects = Array.isArray(o.projects)
		? o.projects.map(sanitizeProject).filter((p): p is WorkspaceProject => p !== undefined)
		: [];
	const deletedRoots = Array.isArray(o.deletedRoots)
		? [
				...new Set(
					o.deletedRoots
						.filter((d): d is string => typeof d === "string" && path.isAbsolute(d))
						.map(d => normalizeWorkspaceDirectory(d)),
				),
			]
		: [];
	const deletedRootTimes: Record<string, number> = {};
	const rawTimes = o.deletedRootTimes;
	if (rawTimes && typeof rawTimes === "object" && !Array.isArray(rawTimes)) {
		for (const [root, at] of Object.entries(rawTimes)) {
			if (typeof at !== "number" || !Number.isFinite(at) || !path.isAbsolute(root)) continue;
			deletedRootTimes[normalizeWorkspaceDirectory(root)] = at;
		}
	}
	return { version: REGISTRY_VERSION, projects, deletedRoots, deletedRootTimes };
}

export interface WorkspaceRegistryOptions {
	/** Override the store path (tests); defaults to `<config root>/projects.json`. */
	filePath?: string;
	/** Clock seam so tests can make ordering deterministic. */
	now?: () => number;
}

/**
 * `projects.json` store. All mutations run through one in-process promise
 * queue, so two RPCs cannot read-modify-write the same file concurrently.
 */
export class WorkspaceRegistry {
	readonly #filePath: () => string;
	readonly #now: () => number;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: WorkspaceRegistryOptions = {}) {
		const explicit = options.filePath;
		this.#filePath = explicit ? () => explicit : () => path.join(getConfigRootDir(), REGISTRY_FILENAME);
		this.#now = options.now ?? (() => Date.now());
	}

	get filePath(): string {
		return this.#filePath();
	}

	/**
	 * Roots the user removed. Their sessions stay on disk but are not listed;
	 * re-creating the workspace lifts the tombstone.
	 */
	async deletedRoots(): Promise<readonly string[]> {
		const file = await this.#read();
		return [...file.deletedRoots];
	}

	/** Roots removed at some point plus their removal times (see
	 *  {@link sessionHiddenByWorkspace}). */
	async deletedRootTimes(): Promise<Readonly<Record<string, number>>> {
		const file = await this.#read();
		return { ...file.deletedRootTimes };
	}

	/**
	 * Additional directories registered for the project rooted at `root`.
	 *
	 * New sessions inherit this set. Read-only: unlike {@link list} it never
	 * backfills implicit rows or prunes stale ones, because a session create
	 * must not mutate the project catalog.
	 */
	async directoriesForRoot(root: string): Promise<string[]> {
		let normalized: string;
		try {
			normalized = normalizeWorkspaceDirectory(root);
		} catch {
			return [];
		}
		const file = await this.#read();
		const project = file.projects.find(row => row.root === normalized);
		return project ? [...project.additionalDirs] : [];
	}

	/**
	 * List projects newest-first, backfilling implicit entries for session cwds
	 * that are not registered and not tombstoned by an explicit delete.
	 */
	async list(backfillCwds: readonly string[] = []): Promise<WorkspaceProject[]> {
		return this.#runExclusive(async () => {
			const file = await this.#read();
			const initialLength = file.projects.length;
			let changed = false;
			const knownRoots = new Set(file.projects.map(project => project.root));
			const now = this.#now();
			for (const cwd of backfillCwds) {
				if (typeof cwd !== "string" || cwd.length === 0) continue;
				let root: string;
				try {
					root = normalizeWorkspaceDirectory(cwd);
				} catch {
					continue;
				}
				if (knownRoots.has(root) || file.deletedRoots.includes(root)) continue;
				file.projects.push({
					id: implicitWorkspaceId(root),
					root,
					name: defaultWorkspaceName(root),
					kind: "implicit",
					additionalDirs: [],
					createdAt: now,
					lastOpenedAt: now,
				});
				knownRoots.add(root);
				changed = true;
			}
			// Implicit rows exist only because a session lived in that directory.
			// Once the last one is gone the row would linger forever as an empty
			// project (user: 出现旧的空工作区). Managed rows stay — they were
			// registered on purpose.
			const liveRoots = new Set<string>();
			for (const cwd of backfillCwds) {
				try {
					liveRoots.add(normalizeWorkspaceDirectory(cwd));
				} catch {
					// Invalid cwd: no session can live there, so it cannot keep a row.
				}
			}
			const retained = file.projects.filter(project => project.kind !== "implicit" || liveRoots.has(project.root));
			if (retained.length !== file.projects.length) changed = true;
			const projects = dedupeProjects(retained);
			if (projects.length !== initialLength) changed = true;
			if (changed) {
				file.projects = projects;
				await this.#write(file);
			}
			return projects;
		});
	}

	/**
	 * Register a project, or touch/merge the existing record for the same root.
	 * Explicit creation promotes an implicit row to `managed` and keeps its id.
	 */
	async create(input: {
		root: string;
		name?: string;
		additionalDirs?: readonly unknown[];
	}): Promise<WorkspaceMutationResult> {
		const root = normalizeWorkspaceDirectory(input.root);
		await requireDirectory(root);
		const resolved = await resolveWorkspaceDirectories(root, input.additionalDirs ?? []);
		return this.#runExclusive(async () => {
			const file = await this.#read();
			const now = this.#now();
			const existing = file.projects.find(project => project.root === root);
			const duplicates = [...resolved.duplicates];
			const mergedDirs = existing ? [...existing.additionalDirs] : [];
			for (const directory of resolved.directories) {
				if (mergedDirs.includes(directory)) {
					duplicates.push({ path: directory, directory });
					continue;
				}
				mergedDirs.push(directory);
			}
			const workspace: WorkspaceProject = existing
				? {
						...existing,
						name: normalizeWorkspaceName(input.name, existing.name),
						kind: "managed",
						additionalDirs: mergedDirs,
						lastOpenedAt: now,
					}
				: {
						id: `wm_${randomUUID()}`,
						root,
						name: normalizeWorkspaceName(input.name, defaultWorkspaceName(root)),
						kind: "managed",
						additionalDirs: mergedDirs,
						createdAt: now,
						lastOpenedAt: now,
					};
			file.projects = existing
				? file.projects.map(project => (project === existing ? workspace : project))
				: [...file.projects, workspace];
			file.deletedRoots = file.deletedRoots.filter(deleted => deleted !== root);
			await this.#write(file);
			return { workspace, duplicates };
		});
	}

	/** Rename and/or replace the additional directory set (full replace). */
	async update(
		id: string,
		patch: { name?: string; additionalDirs?: readonly unknown[] },
	): Promise<WorkspaceMutationResult | undefined> {
		if (patch.name === undefined && patch.additionalDirs === undefined) {
			throw new Error("At least one of name or additionalDirs is required.");
		}
		return this.#runExclusive(async () => {
			const file = await this.#read();
			const existing = file.projects.find(project => project.id === id);
			if (!existing) return undefined;
			const resolved =
				patch.additionalDirs === undefined
					? { directories: existing.additionalDirs, duplicates: [] as WorkspaceDuplicateDirectory[] }
					: await resolveWorkspaceDirectories(existing.root, patch.additionalDirs);
			const workspace: WorkspaceProject = {
				...existing,
				name: patch.name === undefined ? existing.name : normalizeWorkspaceName(patch.name, existing.name),
				additionalDirs: resolved.directories,
				lastOpenedAt: this.#now(),
			};
			file.projects = file.projects.map(project => (project.id === id ? workspace : project));
			await this.#write(file);
			return { workspace, duplicates: resolved.duplicates };
		});
	}

	/** Unregister a project without touching on-disk content. */
	async delete(id: string): Promise<boolean> {
		return this.#runExclusive(async () => {
			const file = await this.#read();
			const existing = file.projects.find(project => project.id === id);
			if (!existing) return false;
			file.projects = file.projects.filter(project => project.id !== id);
			if (!file.deletedRoots.includes(existing.root)) file.deletedRoots.push(existing.root);
			file.deletedRootTimes[existing.root] = this.#now();
			await this.#write(file);
			return true;
		});
	}

	/**
	 * Promote one of the workspace directories to the primary root. The old
	 * root takes the promoted directory's place in `additionalDirs` (atomic
	 * swap; id and timestamps are preserved).
	 */
	async setPrimary(id: string, directory: string): Promise<WorkspaceProject | undefined> {
		return this.#runExclusive(async () => {
			const file = await this.#read();
			const existing = file.projects.find(project => project.id === id);
			if (!existing) return undefined;
			const target = normalizeWorkspaceDirectory(directory, existing.root);
			if (target === existing.root) return existing;
			if (!existing.additionalDirs.includes(target)) {
				throw new WorkspaceDirectoryError(
					"WORKSPACE_DIRECTORY_NOT_IN_WORKSPACE",
					`Directory is not part of this workspace: ${directory}`,
					directory,
				);
			}
			await requireDirectory(target);
			const workspace: WorkspaceProject = {
				...existing,
				root: target,
				additionalDirs: [
					existing.root,
					...existing.additionalDirs.filter(dir => dir !== target && dir !== existing.root),
				],
				lastOpenedAt: this.#now(),
			};
			file.projects = file.projects.map(project => (project.id === id ? workspace : project));
			await this.#write(file);
			await this.#migratePersistedSessions(existing.root, target);
			return workspace;
		});
	}

	/** Follow a primary swap for sessions already on disk: their header cwd and
	 *  artifacts move with the new root instead of resuming into the old one. */
	async #migratePersistedSessions(previousRoot: string, nextRoot: string): Promise<void> {
		const previous = path.resolve(previousRoot);
		const next = path.resolve(nextRoot);
		if (previous === next) return;
		const { listAllSessions } = await import("../../session/session-listing");
		const { SessionManager } = await import("../../session/session-manager");
		const infos = await listAllSessions();
		let migrated = 0;
		for (const info of infos) {
			if (migrated >= 100) break;
			if (!info.cwd || path.resolve(info.cwd) !== previous) continue;
			try {
				const manager = await SessionManager.open(info.path, undefined, undefined, { suppressBreadcrumb: true });
				await manager.moveTo(next);
				await manager.close();
				migrated += 1;
			} catch (error) {
				logger.warn("workspace primary: failed to migrate persisted session", {
					path: info.path,
					error: String(error),
				});
			}
		}
	}

	async #runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(operation, operation);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	async #read(): Promise<WorkspaceRegistryFile> {
		let raw: string;
		try {
			raw = await fs.readFile(this.#filePath(), "utf8");
		} catch (err) {
			if (isEnoent(err)) return emptyRegistry();
			throw err;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			logger.warn("workspace registry: ignoring malformed projects.json", { path: this.#filePath() });
			return emptyRegistry();
		}
		return parseRegistry(parsed);
	}

	async #write(file: WorkspaceRegistryFile): Promise<void> {
		const target = this.#filePath();
		const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
		await fs.mkdir(path.dirname(target), { recursive: true });
		await Bun.write(temp, `${JSON.stringify(file, null, 2)}\n`);
		try {
			await fs.rename(temp, target);
		} catch (err) {
			await fs.rm(temp, { force: true }).catch(() => {});
			throw err;
		}
	}
}

/** Live-session directory surface (SessionManager methods behind the host). */
export interface WorkspaceSessionDirectories {
	readonly cwd: string;
	list(): string[];
	add(directory: string): Promise<string | null>;
	remove(directory: string): Promise<string | null>;
}

export interface WorkspaceServiceDeps {
	registry: WorkspaceRegistry;
	/** Distinct cwds of known sessions; implicit projects are backfilled from them. */
	knownSessionCwds(): Promise<readonly string[]>;
	/** Undefined for a session that is not live. */
	sessionDirectories(sessionId: string): WorkspaceSessionDirectories | undefined;
}

function requiredString(params: Record<string, unknown> | undefined, key: string): string {
	const value = params?.[key];
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${key} required`);
	return value.trim();
}

function directoryInfo(cwd: string, additionalDirs: readonly string[]): Promise<SessionDirectoryInfo[]> {
	return Promise.all(
		[cwd, ...additionalDirs].map(async (directory, index) => ({
			path: directory,
			primary: index === 0,
			exists: await workspaceDirectoryExists(directory),
		})),
	);
}

export class WorkspaceService implements DaemonService {
	readonly key = "workspaces";
	readonly routes = {
		"workspace.list": "listWorkspaces",
		"workspace.create": "createWorkspace",
		"workspace.update": "updateWorkspace",
		"workspace.delete": "deleteWorkspace",
		"workspace.setPrimary": "setPrimary",
		"session.directories.list": "listSessionDirectories",
		"session.directories.add": "addSessionDirectory",
		"session.directories.remove": "removeSessionDirectory",
	} as const;

	readonly #deps: WorkspaceServiceDeps;

	constructor(deps: WorkspaceServiceDeps) {
		this.#deps = deps;
	}

	/** RPC workspace.list：持久化项目 + 会话 cwd 回填的隐式项目。 */
	async listWorkspaces(): Promise<{ workspaces: WorkspaceProject[] }> {
		const cwds = await this.#deps.knownSessionCwds();
		return { workspaces: await this.#deps.registry.list(cwds) };
	}

	/** Project directories a new session rooted at `root` inherits. */
	async directoriesForRoot(root: string): Promise<string[]> {
		return this.#deps.registry.directoriesForRoot(root);
	}

	/** Removed-workspace evidence for the session-list filter. */
	async deletedWorkspaces(): Promise<DeletedWorkspaces> {
		const [roots, deletedAt] = await Promise.all([
			this.#deps.registry.deletedRoots(),
			this.#deps.registry.deletedRootTimes(),
		]);
		return { roots: new Set(roots), deletedAt };
	}

	/** RPC workspace.create：显式注册（同 root 幂等合并）。 */
	async createWorkspace(params: Record<string, unknown> | undefined): Promise<WorkspaceMutationResult> {
		const root = requiredString(params, "root");
		const name = typeof params?.name === "string" ? params.name : undefined;
		const additionalDirs = params?.additionalDirs;
		if (additionalDirs !== undefined && !Array.isArray(additionalDirs)) {
			throw new Error("additionalDirs must be an array.");
		}
		return this.#deps.registry.create({ root, name, additionalDirs: additionalDirs ?? [] });
	}

	/** RPC workspace.update：改名 / 全量替换 additionalDirs。 */
	async updateWorkspace(params: Record<string, unknown> | undefined): Promise<WorkspaceMutationResult> {
		const id = requiredString(params, "id");
		const name = typeof params?.name === "string" ? params.name : undefined;
		const additionalDirs = params?.additionalDirs;
		if (additionalDirs !== undefined && !Array.isArray(additionalDirs)) {
			throw new Error("additionalDirs must be an array.");
		}
		const result = await this.#deps.registry.update(id, { name, additionalDirs });
		if (!result) throw new Error(`Workspace not found: ${id}`);
		return result;
	}

	/** RPC workspace.delete：仅注销注册表，不删磁盘内容。 */
	async deleteWorkspace(params: Record<string, unknown> | undefined): Promise<{ deleted: boolean }> {
		return { deleted: await this.#deps.registry.delete(requiredString(params, "id")) };
	}

	/** RPC workspace.setPrimary：把已登记的目录提升为主目录。 */
	async setPrimary(params: Record<string, unknown> | undefined): Promise<{ workspace: WorkspaceProject }> {
		const id = requiredString(params, "id");
		const directory = requiredString(params, "path");
		const workspace = await this.#deps.registry.setPrimary(id, directory);
		if (!workspace) throw new Error(`Workspace not found: ${id}`);
		return { workspace };
	}

	/** RPC session.directories.list：主目录在前，附磁盘存在性。 */
	async listSessionDirectories(
		params: Record<string, unknown> | undefined,
	): Promise<{ sessionId: string; cwd: string; directories: SessionDirectoryInfo[] }> {
		const sessionId = requiredString(params, "sessionId");
		const handle = this.#requireSession(sessionId);
		return {
			sessionId,
			cwd: handle.cwd,
			directories: await directoryInfo(handle.cwd, handle.list()),
		};
	}

	/**
	 * RPC session.directories.add：校验存在性/上限后写入会话头。
	 * 已在集合内的目录不报错，返回 `{ added: false, duplicate }` 供 GUI 提示。
	 */
	async addSessionDirectory(params: Record<string, unknown> | undefined): Promise<{
		added: boolean;
		directory: string | null;
		duplicate: WorkspaceDuplicateDirectory | null;
		directories: SessionDirectoryInfo[];
	}> {
		const sessionId = requiredString(params, "sessionId");
		const requested = requiredString(params, "directory");
		const handle = this.#requireSession(sessionId);
		const resolved = normalizeWorkspaceDirectory(requested, handle.cwd);
		const current = handle.list();
		if (resolved === handle.cwd || current.includes(resolved)) {
			return {
				added: false,
				directory: null,
				duplicate: { path: requested, directory: resolved },
				directories: await directoryInfo(handle.cwd, current),
			};
		}
		if (current.length >= MAX_WORKSPACE_DIRECTORIES) {
			throw new WorkspaceDirectoryError(
				"WORKSPACE_DIRECTORY_LIMIT",
				`A workspace can have at most ${MAX_WORKSPACE_DIRECTORIES} additional directories.`,
			);
		}
		await requireDirectory(resolved);
		await requireSafeAdditionalDirectory(resolved);
		const added = await handle.add(resolved);
		const next = handle.list();
		return {
			added: added !== null,
			directory: added,
			duplicate: added === null ? { path: requested, directory: resolved } : null,
			directories: await directoryInfo(handle.cwd, next),
		};
	}

	/** RPC session.directories.remove：未知目录返回 `{ removed: false }`。 */
	async removeSessionDirectory(params: Record<string, unknown> | undefined): Promise<{
		removed: boolean;
		directory: string;
		directories: SessionDirectoryInfo[];
	}> {
		const sessionId = requiredString(params, "sessionId");
		const requested = requiredString(params, "directory");
		const handle = this.#requireSession(sessionId);
		const removed = await handle.remove(requested);
		return {
			removed: removed !== null,
			directory: removed ?? normalizeWorkspaceDirectory(requested, handle.cwd),
			directories: await directoryInfo(handle.cwd, handle.list()),
		};
	}

	#requireSession(sessionId: string): WorkspaceSessionDirectories {
		const handle = this.#deps.sessionDirectories(sessionId);
		if (!handle) throw new Error(`Session not live: ${sessionId}`);
		return handle;
	}
}
