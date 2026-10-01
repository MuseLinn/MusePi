import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTerminalId } from "@musepi/pi-tui";
import {
	getSessionsDir,
	getTerminalSessionsDir,
	isEnoent,
	logger,
	normalizePathForComparison,
	resolveEquivalentPath,
} from "@musepi/pi-utils";
import type { SessionStorage } from "./session-storage";

const migratedSessionRoots = new Set<string>();

/**
 * Merge or rename a legacy session directory into its canonical target.
 * Best effort: callers decide whether migration failures should surface.
 */
function migrateSessionDirPath(oldPath: string, newPath: string): void {
	const existing = fs.statSync(newPath, { throwIfNoEntry: false });
	if (existing?.isDirectory()) {
		for (const file of fs.readdirSync(oldPath)) {
			const src = path.join(oldPath, file);
			const dst = path.join(newPath, file);
			if (fs.existsSync(dst)) {
				logger.warn("Session directory migration collision; preserving legacy entry", { src, dst });
				continue;
			}
			fs.renameSync(src, dst);
		}
		fs.rmdirSync(oldPath);
		return;
	}
	if (existing) {
		fs.rmSync(newPath, { recursive: true, force: true });
	}
	fs.renameSync(oldPath, newPath);
}

function encodeLegacyAbsoluteSessionDirName(cwd: string): string {
	const resolvedCwd = path.resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
	const encoded = relative.replace(/[/\\:]/g, "-");
	return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
}

/**
 * Reconstruct the short-lived hashed session dir name used by 17.2.5-17.2.8
 * (reverted PR #7397): `<scope>-<readable>-<sha256hex>` keyed by the canonical
 * cwd. Kept only so {@link migrateHashedSessionDir} can recover sessions
 * stranded when 17.2.9 restored the legacy names without a reverse migration.
 */
function encodeHashedSessionDirName(canonicalCwd: string, scope: "home" | "tmp" | "abs"): string {
	const normalized = canonicalCwd.replaceAll("\\", "/");
	const readable = path
		.basename(canonicalCwd)
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	const digest = Bun.SHA256.hash(normalized, "hex");
	return `${scope}-${readable || "project"}-${digest}`;
}

function getDefaultSessionDirName(cwd: string): {
	encodedDirName: string;
	hashedDirName: string;
	resolvedCwd: string;
} {
	// normalizePathForComparison = realpath + 平台大小写归一（Windows 上
	// 大小写不敏感）：同一物理目录经不同大小写/符号链接写法传入时必须
	// 分类到同一作用域、生成同一 slug，否则一个项目分裂成两个会话目录。
	const resolvedCwd = path.resolve(cwd);
	const canonicalCwd = normalizePathForComparison(resolvedCwd);
	const home = os.homedir();
	const canonicalHome = normalizePathForComparison(home);
	const tempRoot = os.tmpdir();
	const canonicalTempRoot = normalizePathForComparison(tempRoot);
	const homeRelative = path.relative(canonicalHome, canonicalCwd);
	const tempRelative = path.relative(canonicalTempRoot, canonicalCwd);
	let encodedDirName: string;
	let scope: "home" | "tmp" | "abs";
	if (homeRelative === "" || (!homeRelative.startsWith("..") && !path.isAbsolute(homeRelative))) {
		encodedDirName = encodeRelativeSessionDirName("-", homeRelative);
		scope = "home";
	} else if (tempRelative === "" || (!tempRelative.startsWith("..") && !path.isAbsolute(tempRelative))) {
		encodedDirName = encodeRelativeSessionDirName("-tmp", tempRelative);
		scope = "tmp";
	} else {
		encodedDirName = encodeLegacyAbsoluteSessionDirName(canonicalCwd);
		scope = "abs";
	}
	// 哈希 slug（17.2.5-17.2.8 遗物）的 SHA 输入保持大小写保留的等价路径：
	// 旧产物是按原始大小写哈希的，换键会让迁移查找失配、搁浅旧会话。
	const equivalentCwd = resolveEquivalentPath(resolvedCwd);
	return { encodedDirName, hashedDirName: encodeHashedSessionDirName(equivalentCwd, scope), resolvedCwd };
}

/**
 * Migrate old `--<home-encoded>-*--` session dirs to the new `-*` format.
 * Runs once per sessions root on first access, best-effort.
 */
function migrateHomeSessionDirs(sessionsRoot: string): void {
	if (migratedSessionRoots.has(sessionsRoot)) return;
	migratedSessionRoots.add(sessionsRoot);

	const home = os.homedir();
	const homeEncoded = home.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
	const oldPrefix = `--${homeEncoded}-`;
	const oldExact = `--${homeEncoded}--`;

	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
		return;
	}

	for (const entry of entries) {
		let remainder: string;
		if (entry === oldExact) {
			remainder = "";
		} else if (entry.startsWith(oldPrefix) && entry.endsWith("--")) {
			remainder = entry.slice(oldPrefix.length, -2);
		} else {
			continue;
		}

		const newName = remainder ? `-${remainder}` : "-";
		const oldPath = path.join(sessionsRoot, entry);
		const newPath = path.join(sessionsRoot, newName);

		try {
			migrateSessionDirPath(oldPath, newPath);
		} catch (error) {
			logger.warn("Failed to migrate legacy home session directory", {
				oldPath,
				newPath,
				error: String(error),
			});
		}
	}
}

function migrateLegacyAbsoluteSessionDir(cwd: string, sessionDir: string, sessionsRoot: string): void {
	const legacyDir = path.join(sessionsRoot, encodeLegacyAbsoluteSessionDirName(cwd));
	if (legacyDir === sessionDir || !fs.existsSync(legacyDir)) return;

	try {
		migrateSessionDirPath(legacyDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate legacy session directory", {
			oldPath: legacyDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

/**
 * Migrate a 17.2.5-17.2.8 hashed session dir back into its legacy path-based
 * directory. The 17.2.9 revert restored the legacy names but dropped migration,
 * stranding sessions written under the hashed scheme (issue #7677). Best-effort.
 */
function migrateHashedSessionDir(hashedDirName: string, sessionDir: string, sessionsRoot: string): void {
	const hashedDir = path.join(sessionsRoot, hashedDirName);
	if (hashedDir === sessionDir || !fs.existsSync(hashedDir)) return;

	try {
		migrateSessionDirPath(hashedDir, sessionDir);
	} catch (error) {
		logger.warn("Failed to migrate hashed session directory", {
			oldPath: hashedDir,
			newPath: sessionDir,
			error: String(error),
		});
	}
}

export function resolveManagedSessionRoot(sessionDir: string, cwd: string): string | undefined {
	const currentDirName = path.basename(sessionDir);
	const { encodedDirName } = getDefaultSessionDirName(cwd);
	// Windows 大小写不敏感：现存目录可能是 slug 归一化之前创建的原始大小写
	// 变体（resolveCaseVariantDirName 复用不重命名），匹配随之放宽。
	const matches = (a: string, b: string): boolean =>
		process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	if (!matches(currentDirName, encodedDirName) && !matches(currentDirName, encodeLegacyAbsoluteSessionDirName(cwd))) {
		return undefined;
	}
	return path.dirname(sessionDir);
}

/**
 * Windows 大小写不敏感：同一 cwd 的大小写变体必须落到同一个 slug 目录，
 * 否则历史目录（如 `-AppData-Local-Programs-MusePi`，建于大小写归一生效
 * 之前）与新生成的小写 slug 各收各的会话，一个项目分裂成两个工作区。
 * 返回 sessionsRoot 下与 encodedDirName 大小写不敏感匹配的现存目录名
 * （精确匹配快速返回）；无匹配返回 encodedDirName 本身。只读，不建目录。
 */
function resolveCaseVariantDirName(sessionsRoot: string, encodedDirName: string): string {
	// Windows 的 existsSync 走大小写不敏感的文件系统：「精确目录已存在」
	// 不能用它判断（小写探测会命中大写变体），必须列目录做大小写敏感的
	// 精确匹配；POSIX 文件系统本身大小写敏感，无变体问题，直接返回。
	if (process.platform !== "win32") return encodedDirName;
	let entries: string[];
	try {
		entries = fs.readdirSync(sessionsRoot);
	} catch {
		return encodedDirName;
	}
	if (entries.includes(encodedDirName)) return encodedDirName;
	const lower = encodedDirName.toLowerCase();
	return entries.find(e => e.toLowerCase() === lower) ?? encodedDirName;
}

/**
 * Read-only variant of {@link computeDefaultSessionDir} for existence probes:
 * computes the canonical slug dir for a cwd WITHOUT running migrations or
 * creating the directory. Ghost-row reconciliation uses it to test whether a
 * session's workspace tree still exists at all. Shares the case-variant
 * resolution with compute so a probe and a create always agree on the dir.
 */
export function peekDefaultSessionDir(cwd: string, sessionsRoot: string = getSessionsDir()): string {
	const { encodedDirName } = getDefaultSessionDirName(cwd);
	return path.join(sessionsRoot, resolveCaseVariantDirName(sessionsRoot, encodedDirName));
}

/**
 * Compute the default session directory for a cwd.
 * Classifies cwd by canonical location so symlink/alias paths resolve to the
 * same home-relative or temp-root directory names as their real targets.
 */
export function computeDefaultSessionDir(
	cwd: string,
	storage: SessionStorage,
	sessionsRoot: string = getSessionsDir(),
): string {
	const { encodedDirName, hashedDirName, resolvedCwd } = getDefaultSessionDirName(cwd);
	migrateHomeSessionDirs(sessionsRoot);
	// 现存目录的大小写变体优先复用（Windows 大小写不敏感）——首次出现的
	// 写法赢得目录名，后来的大小写变体并入同一目录，不分裂工作区。
	const sessionDir = path.join(sessionsRoot, resolveCaseVariantDirName(sessionsRoot, encodedDirName));
	migrateLegacyAbsoluteSessionDir(resolvedCwd, sessionDir, sessionsRoot);
	migrateHashedSessionDir(hashedDirName, sessionDir, sessionsRoot);
	storage.ensureDirSync(sessionDir);
	return sessionDir;
}

// =============================================================================
// Terminal breadcrumbs: maps terminal (TTY) -> last session file for --continue
// =============================================================================

/**
 * Write a breadcrumb linking the current terminal to a session file.
 * The breadcrumb contains the cwd and session path so --continue can
 * find "this terminal's last session" even when running concurrent instances.
 *
 * `fresh` marks a `/new` (or freshly-minted) session boundary whose JSONL is
 * not yet materialized (new-session persistence is lazy until assistant output
 * exists). A fresh breadcrumb is honored by {@link readTerminalBreadcrumbEntry}
 * even when its target file is still absent, so relaunch/auto-resume reopens the
 * post-`/new` session instead of falling back to the pre-`/new` transcript. Once
 * the session materializes the caller rewrites the breadcrumb with `fresh:false`
 * so a later external delete is still treated as a genuinely stale crumb.
 */
export function writeTerminalBreadcrumb(cwd: string, sessionFile: string, fresh = false): void {
	const terminalId = getTerminalId();
	if (!terminalId) return;

	const breadcrumbDir = getTerminalSessionsDir();
	const breadcrumbFile = path.join(breadcrumbDir, terminalId);
	const content = fresh ? `${cwd}\n${sessionFile}\nfresh\n` : `${cwd}\n${sessionFile}\n`;
	// Synchronous + best-effort. Infrequent (session create/switch/reset, never
	// per-append), and writing in order matters: a lazy `/new` fresh crumb is
	// re-stamped non-fresh the instant the session materializes, so an async
	// fire-and-forget could land the two writes out of order and leave a
	// materialized session marked fresh.
	try {
		fs.mkdirSync(breadcrumbDir, { recursive: true });
		fs.writeFileSync(breadcrumbFile, content);
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb write failed", { err });
	}
}

export interface TerminalBreadcrumb {
	cwd: string;
	sessionFile: string;
	/** The recorded session file exists on disk right now. */
	exists: boolean;
	/** Recorded as a `/new` fresh-session boundary whose JSONL may not exist yet. */
	fresh: boolean;
}

/**
 * Read the raw terminal breadcrumb for the current terminal.
 * Returns the recorded cwd + session file regardless of whether the recorded
 * cwd still matches the current one. Callers decide how to interpret a cwd
 * mismatch (e.g. a moved/renamed worktree).
 *
 * A missing target file yields `null` UNLESS the breadcrumb is a `fresh`
 * boundary — a lazy `/new` session whose JSONL was never written — in which case
 * the entry is returned with `exists:false` so the caller can distinguish it
 * from a genuinely stale/deleted breadcrumb.
 */
export async function readTerminalBreadcrumbEntry(): Promise<TerminalBreadcrumb | null> {
	const terminalId = getTerminalId();
	if (!terminalId) return null;

	try {
		const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId);
		const content = await Bun.file(breadcrumbFile).text();
		const lines = content.trim().split("\n");
		if (lines.length < 2) return null;

		const breadcrumbCwd = lines[0];
		const sessionFile = lines[1];
		const fresh = lines[2] === "fresh";

		const stat = fs.statSync(sessionFile, { throwIfNoEntry: false });
		const exists = stat?.isFile() === true;
		// A materialized target resumes normally; a missing target is honored only
		// for a fresh `/new` boundary (never-written lazy session).
		if (exists || fresh) return { cwd: breadcrumbCwd, sessionFile, exists, fresh };
	} catch (err) {
		if (!isEnoent(err)) logger.debug("Terminal breadcrumb read failed", { err });
		// Breadcrumb doesn't exist or is corrupt — fall through
	}
	return null;
}
