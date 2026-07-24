// ============================================================
// MusePi LSP — server detection and config resolution.
//
// A server is available for a session when its root markers intersect the
// project (markers at the session cwd, or an ancestor of the file being
// served) AND its binary resolves. Binary lookup order:
//   1. project-local bins (node_modules/.bin, .venv/…, vendor/bundle/bin…)
//   2. $PATH (with PATHEXT on Windows)
// User overrides from musepi.lsp.servers merge per-server onto the
// built-in table; `disabled: true` removes an entry.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { BUILTIN_LSP_SERVERS } from "./defaults.ts";
import type { LspServerConfig, LspServerOverride, ResolvedLspServer } from "./types.ts";

// =============================================================================
// Root markers
// =============================================================================

function globToRegExp(glob: string): RegExp {
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/** Check whether any root marker exists directly in `dir` (one level, no recursion). */
export function hasRootMarkers(dir: string, markers: string[]): boolean {
	let entries: string[] | null = null;
	for (const marker of markers) {
		if (marker.includes("*") || marker.includes("?")) {
			if (entries === null) {
				try {
					entries = fs.readdirSync(dir);
				} catch {
					entries = [];
				}
			}
			const re = globToRegExp(marker);
			if (entries.some((entry) => re.test(entry))) return true;
			continue;
		}
		if (fs.existsSync(path.join(dir, marker))) return true;
	}
	return false;
}

/** Whether any ancestor directory of `filePath` carries one of the markers. */
export function hasRootMarkerAncestor(filePath: string, markers: string[]): boolean {
	if (markers.length === 0) return false;
	let dir = path.dirname(path.resolve(filePath));
	for (;;) {
		if (hasRootMarkers(dir, markers)) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

// =============================================================================
// Binary resolution
// =============================================================================

const PYTHON_MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "pyrightconfig.json"];

/** Project-local bin dirs, gated on the markers that imply them, checked before $PATH. */
const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	{ markers: PYTHON_MARKERS, binDir: ".venv/bin" },
	{ markers: PYTHON_MARKERS, binDir: ".venv/Scripts" },
	{ markers: PYTHON_MARKERS, binDir: "venv/bin" },
	{ markers: PYTHON_MARKERS, binDir: "venv/Scripts" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	{ markers: ["go.mod", "go.sum", "go.work"], binDir: "bin" },
];

const WINDOWS_EXECUTABLE_EXTENSIONS = [".cmd", ".exe", ".bat", ".ps1"];

function executableCandidates(basePath: string): string[] {
	if (process.platform !== "win32") return [basePath];
	// Already carries an extension (node.exe, server.cmd) — use as-is.
	if (path.extname(basePath) !== "") return [basePath];
	// Windows never executes extensionless files (npm's bare POSIX shims are
	// not spawnable) — only the PATHEXT-style launcher variants count.
	return WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => `${basePath}${ext}`);
}

function resolveExecutable(basePath: string): string | null {
	for (const candidate of executableCandidates(basePath)) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// not present — keep looking
		}
	}
	return null;
}

function resolveCommandFromLocalBins(command: string, cwd: string): string | null {
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (!hasRootMarkers(cwd, markers)) continue;
		const resolved = resolveExecutable(path.join(cwd, binDir, command));
		if (resolved) return resolved;
	}
	return null;
}

/** Minimal cross-platform `which`: PATH entries × PATHEXT (Windows), executable files only. */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
	if (command.includes("/") || command.includes("\\")) {
		return resolveExecutable(path.resolve(command));
	}
	const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
	const extensions =
		process.platform === "win32"
			? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.toLowerCase())
			: [""];
	for (const dir of pathEnv.split(path.delimiter)) {
		if (!dir) continue;
		const base = path.join(dir, command);
		const candidates =
			process.platform === "win32" && path.extname(command) === ""
				? // No extension: only PATHEXT launchers are executable on Windows
					// (a bare extensionless match is a POSIX shim and won't spawn).
					extensions.map((ext) => `${base}${ext}`)
				: [base];
		for (const candidate of candidates) {
			try {
				const stat = fs.statSync(candidate);
				if (!stat.isFile()) continue;
				if (process.platform !== "win32") {
					fs.accessSync(candidate, fs.constants.X_OK);
				}
				return candidate;
			} catch {
				// not here / not executable — next entry
			}
		}
	}
	return null;
}

/**
 * Resolve a server command to a spawnable executable: project-local bins
 * first, then $PATH. Returns null when the server is not installed.
 */
export function resolveCommand(command: string, cwd: string): string | null {
	return resolveCommandFromLocalBins(command, cwd) ?? which(command);
}

// =============================================================================
// Config merge + detection
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : undefined;
}

function normalizeServerConfig(name: string, raw: LspServerConfig): LspServerConfig | null {
	const command = typeof raw.command === "string" && raw.command.length > 0 ? raw.command : null;
	const fileTypes = normalizeStringList(raw.fileTypes);
	const rootMarkers = normalizeStringList(raw.rootMarkers) ?? [];
	if (!command || !fileTypes) return null;
	return {
		command,
		...(Array.isArray(raw.args) ? { args: raw.args.filter((a): a is string => typeof a === "string") } : {}),
		fileTypes,
		rootMarkers,
		...(raw.isLinter !== undefined ? { isLinter: raw.isLinter } : {}),
		...(raw.disabled !== undefined ? { disabled: raw.disabled } : {}),
		...(isRecord(raw.initOptions) ? { initOptions: raw.initOptions } : {}),
		...(isRecord(raw.settings) ? { settings: raw.settings } : {}),
	};
}

/** Merge user overrides onto the built-in table (per-server, field-wise). */
export function mergeServerOverrides(
	overrides: Record<string, LspServerOverride> | undefined,
): Record<string, LspServerConfig> {
	const merged: Record<string, LspServerConfig> = { ...BUILTIN_LSP_SERVERS };
	for (const [name, override] of Object.entries(overrides ?? {})) {
		if (!isRecord(override)) continue;
		const base = merged[name];
		const candidate = {
			...(base ?? { command: override.command ?? "", fileTypes: [], rootMarkers: [] }),
			...override,
		} as LspServerConfig;
		const normalized = normalizeServerConfig(name, candidate);
		if (normalized) merged[name] = normalized;
	}
	return merged;
}

/**
 * Resolve the servers usable for `cwd`: root markers present ∩ binary
 * resolvable, after merging user overrides. `source` marks whether the
 * winning entry came from the built-in table or a user override.
 */
export function resolveLspServers(
	cwd: string,
	overrides?: Record<string, LspServerOverride>,
): Record<string, ResolvedLspServer> {
	const table = mergeServerOverrides(overrides);
	const resolved: Record<string, ResolvedLspServer> = {};
	for (const [name, config] of Object.entries(table)) {
		if (config.disabled) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolvedCommand = resolveCommand(config.command, cwd);
		if (!resolvedCommand) continue;
		resolved[name] = {
			...config,
			name,
			resolvedCommand,
			source: overrides && name in overrides ? "override" : "builtin",
		};
	}
	return resolved;
}

/**
 * Servers that can handle a file, primary (non-linter) first. Extension
 * and exact-filename forms both match; a missing dot in fileTypes is
 * tolerated.
 */
export function getServersForFile(
	servers: Record<string, ResolvedLspServer>,
	filePath: string,
): ResolvedLspServer[] {
	const ext = path.extname(filePath).toLowerCase();
	const extNoDot = ext.startsWith(".") ? ext.slice(1) : ext;
	const fileName = path.basename(filePath).toLowerCase();
	const matches: ResolvedLspServer[] = [];
	for (const server of Object.values(servers)) {
		const hit = server.fileTypes.some((fileType) => {
			const normalized = fileType.toLowerCase();
			const noDot = normalized.startsWith(".") ? normalized.slice(1) : normalized;
			return normalized === ext || normalized === fileName || noDot === extNoDot || noDot === fileName;
		});
		if (hit) matches.push(server);
	}
	return matches.sort((a, b) => Number(a.isLinter ?? false) - Number(b.isLinter ?? false));
}
