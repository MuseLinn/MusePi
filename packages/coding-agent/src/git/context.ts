import * as path from "node:path";
import { parseNumstat } from "../commit/git/diff";
import { branch, diff, head, mergeBase, ref, repo, revList, status } from "../utils/git";

/**
 * Session-scoped "git scene" for one working directory: repository identity,
 * the base branch a review is measured against, divergence from it, and the
 * changed-file list with line counts and a coarse kind.
 *
 * Everything git-shaped goes through `utils/git`, so timeouts, non-interactive
 * env, and output caps behave like the rest of the agent. Probes are all
 * read-only: `merge-base` plus a working-tree `diff --numstat` filtered to the
 * status paths — never a history-wide diff, which is what makes this safe on a
 * large repository.
 *
 * Nothing is guessed: a missing base branch, an absent upstream, and an
 * unresolvable fork point are all reported as `null`, not as zero.
 */

export type GitChangeKind = "code" | "test" | "docs" | "config" | "style" | "other";

/** Default cap on reported changed files. */
export const GIT_CONTEXT_MAX_FILES = 2000;
/** Default per-probe deadline. One hung command must not pin an RPC open. */
export const GIT_CONTEXT_TIMEOUT_MS = 10_000;
/** An untracked file larger than this reports unknown line counts instead of being read whole. */
const UNTRACKED_MAX_BYTES = 1 << 20;
/** Passing one pathspec per changed file is itself bounded by the OS argument limit. */
const MAX_PATHSPEC_CHARS = 16_000;
const MAX_BASE_REF_LENGTH = 256;

export interface GitContextFile {
	/** Repository-relative path with forward slashes. */
	readonly path: string;
	/** Porcelain v1 `XY` status pair verbatim (`"??"` for untracked). */
	readonly status: string;
	/** Added lines, or `null` when the file is binary or its count is unknown. */
	readonly additions: number | null;
	/** Deleted lines, or `null` when the file is binary or its count is unknown. */
	readonly deletions: number | null;
	readonly kind: GitChangeKind;
}

export interface GitContextBase {
	readonly ref: string;
	readonly source: "param" | "default" | "local" | "remote";
	/** Merge-base of `ref` and HEAD, or `null` when they share no ancestor. */
	readonly forkPoint: string | null;
}

export interface GitContextWorktree {
	readonly linked: boolean;
	readonly gitDir: string;
	readonly commonDir: string;
	/** Primary checkout root that owns the shared object database. */
	readonly mainRoot: string;
}

export interface GitContextHead {
	readonly branch: string | null;
	readonly detached: boolean;
	readonly commit: string | null;
	readonly shortCommit: string | null;
}

export interface GitContextLimits {
	readonly maxFiles: number;
	readonly timeoutMs: number;
}

export interface GitContextAvailable {
	readonly available: true;
	readonly root: string;
	readonly worktree: GitContextWorktree;
	readonly head: GitContextHead;
	readonly base: GitContextBase | null;
	/** `null` when the current branch has no upstream; never `0/0` in that case. */
	readonly upstream: { readonly ahead: number; readonly behind: number } | null;
	readonly files: readonly GitContextFile[];
	/** The status list exceeded `maxFiles`; `files` is a prefix, not the whole set. */
	readonly truncated: boolean;
	/** At least one probe exceeded its deadline, so nullable fields may be missing. */
	readonly timedOut: boolean;
	readonly limits: GitContextLimits;
}

export interface GitContextUnavailable {
	readonly available: false;
	readonly cwd: string;
	readonly reason: "not-a-repository" | "timeout" | "git-error" | "invalid-base";
	readonly detail?: string;
}

export type GitContextResult = GitContextAvailable | GitContextUnavailable;

export interface GitContextOptions {
	/** Base branch override. Empty strings are treated as absent. */
	readonly base?: string;
	readonly maxFiles?: number;
	readonly timeoutMs?: number;
}

export interface GitStatusEntry {
	readonly path: string;
	readonly status: string;
}

export interface GitNumstatRow {
	readonly path: string;
	readonly additions: number | null;
	readonly deletions: number | null;
}

// ════════════════════════════════════════════════════════════════════════════
// File kind classification
// ════════════════════════════════════════════════════════════════════════════

// Order is precedence: a test file is a test even though it is also `.ts`, and
// `docs/README.md` is documentation. Rules live here and nowhere else so a
// future "review by file type" filter has one source of truth.
const TEST_RULES: readonly RegExp[] = [
	/(?:^|\/)(?:__tests__|__snapshots__|__mocks__|tests?|specs?|e2e)\//i,
	/\.(?:test|spec)\.[^/]+$/i,
	/(?:^|\/)test_[^/]+$/i,
	/_test\.[^/]+$/i,
	/\.snap$/i,
];
const DOC_RULES: readonly RegExp[] = [
	/(?:^|\/)docs?\//i,
	/\.(?:md|mdx|rst|adoc)$/i,
	/(?:^|\/)(?:README|CHANGELOG|LICENSE|CONTRIBUTING|AGENTS|CODEOWNERS)(?:\.[^/]*)?$/i,
];
const CONFIG_RULES: readonly RegExp[] = [
	/(?:^|\/)\.env(?:\.[^/]+)?$/i,
	/(?:^|\/)(?:package\.json|package-lock\.json|bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json|biome\.jsonc?|\.gitignore|\.gitattributes|Dockerfile|Makefile)$/i,
	/(?:^|\/)\.github\//i,
	/\.(?:jsonc?|toml|ya?ml|ini|cfg|conf|lock)$/i,
	/\.config\.[^/]+$/i,
];
const STYLE_RULES: readonly RegExp[] = [/\.(?:css|scss|sass|less|styl|pcss)$/i];
const CODE_RULES: readonly RegExp[] = [
	/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|swift|c|h|cc|cpp|cxx|hpp|cs|rb|php|sh|bash|zsh|ps1|lua|zig|scala|ex|exs|erl|hs|ml|dart|ets|vue|svelte|sql)$/i,
];

/** Coarse bucket for one changed path; see {@link GitChangeKind}. */
export function classifyChangeKind(filePath: string): GitChangeKind {
	const normalized = filePath.replaceAll("\\", "/");
	if (TEST_RULES.some(rule => rule.test(normalized))) return "test";
	if (DOC_RULES.some(rule => rule.test(normalized))) return "docs";
	if (CONFIG_RULES.some(rule => rule.test(normalized))) return "config";
	if (STYLE_RULES.some(rule => rule.test(normalized))) return "style";
	if (CODE_RULES.some(rule => rule.test(normalized))) return "code";
	return "other";
}

// ════════════════════════════════════════════════════════════════════════════
// Parsers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * In `-z` form a rename/copy record is `XY <new>\0<old>\0`: the arrow is gone
 * and the destination comes first, so the origin field has to be skipped
 * explicitly or it reads as an extra file called "old-name".
 */
export function parsePorcelainStatusV1Z(output: string): GitStatusEntry[] {
	const entries: GitStatusEntry[] = [];
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const record = fields[index];
		if (!record || record.length < 4) continue;
		const status = record.slice(0, 2);
		if (status === "!!") continue;
		entries.push({ path: record.slice(3), status });
		if (status.includes("R") || status.includes("C")) index += 1;
	}
	return entries;
}

/**
 * Parse `git diff --numstat` keeping binary rows distinguishable from `0/0`.
 * The path is resolved by the central numstat parser so rename notation
 * (`old => new`, `dir/{a => b}/file`) is handled in exactly one place.
 */
export function parseNumstatRows(output: string): GitNumstatRow[] {
	const rows: GitNumstatRow[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [addedRaw = "", deletedRaw = ""] = line.split("\t");
		const entry = parseNumstat(line)[0];
		if (!entry) continue;
		const binary = addedRaw === "-" || deletedRaw === "-";
		rows.push({
			path: normalizePath(entry.path),
			additions: binary ? null : entry.additions,
			deletions: binary ? null : entry.deletions,
		});
	}
	return rows;
}

/** Git reports `/` even on Windows; normalise both sides before comparing. */
export function normalizePath(filePath: string): string {
	return filePath.replaceAll("\\", "/");
}

// ════════════════════════════════════════════════════════════════════════════
// Computation
// ════════════════════════════════════════════════════════════════════════════

type ProbeOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly timedOut: boolean; readonly error?: string };

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Validate a caller-supplied base ref. Returns `null` when it could reach git
 * as an option (`--help`) or is otherwise not a ref-shaped string.
 */
export function normalizeBaseRef(base: string | undefined): string | null | undefined {
	if (base === undefined) return undefined;
	const trimmed = base.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > MAX_BASE_REF_LENGTH) return null;
	if (trimmed.startsWith("-")) return null;
	if (/\s|[\u0000-\u001f\u007f]/.test(trimmed)) return null;
	return trimmed;
}

interface BaseCandidate {
	readonly ref: string;
	readonly source: GitContextBase["source"];
}

function baseCandidates(explicit: string | undefined, defaultBranch: string | null): BaseCandidate[] {
	if (explicit) return [{ ref: explicit, source: "param" }];
	const candidates: BaseCandidate[] = [];
	const push = (refName: string, source: BaseCandidate["source"]): void => {
		if (!candidates.some(candidate => candidate.ref === refName)) candidates.push({ ref: refName, source });
	};
	if (defaultBranch) {
		push(`refs/heads/${defaultBranch}`, "default");
		push(`refs/remotes/origin/${defaultBranch}`, "remote");
	}
	for (const name of ["main", "master"]) {
		push(`refs/heads/${name}`, "local");
		push(`refs/remotes/origin/${name}`, "remote");
	}
	return candidates;
}

function buildPathspecs(paths: readonly string[]): string[] | undefined {
	if (paths.length === 0) return undefined;
	// `:(literal)` keeps `[`, `*`, and `?` in a filename from turning into a glob
	// and silently matching the wrong file. Over the argument budget we drop the
	// filter instead of failing: an unfiltered working-tree numstat is still
	// bounded by the changed set, never by history.
	const pathspecs = paths.map(file => `:(literal)${file}`);
	let total = 0;
	for (const pathspec of pathspecs) {
		total += pathspec.length + 1;
		if (total > MAX_PATHSPEC_CHARS) return undefined;
	}
	return pathspecs;
}

async function countUntrackedAdditions(root: string, file: string): Promise<number | null> {
	const absolute = path.resolve(root, file);
	const relative = path.relative(root, absolute);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
	try {
		const blob = Bun.file(absolute);
		if (blob.size > UNTRACKED_MAX_BYTES) return null;
		const bytes = new Uint8Array(await blob.arrayBuffer());
		if (bytes.includes(0)) return null;
		const text = new TextDecoder().decode(bytes);
		if (!text) return 0;
		const lines = text.split("\n").length;
		return text.endsWith("\n") ? lines - 1 : lines;
	} catch {
		return null;
	}
}

/**
 * Resolve the base branch and its fork point with HEAD.
 *
 * Candidates are checked in order — explicit parameter, the remote default
 * branch, then local `main`/`master`, then their `origin/` counterparts. The
 * first ref that resolves wins; when none does the caller gets `null` rather
 * than a guessed merge base.
 */
async function resolveBase(
	root: string,
	explicit: string | undefined,
	defaultBranch: string | null,
	probe: <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<ProbeOutcome<T>>,
): Promise<GitContextBase | null> {
	for (const candidate of baseCandidates(explicit, defaultBranch)) {
		const resolved = await probe(signal => ref.resolve(root, candidate.ref, signal));
		if (!resolved.ok || !resolved.value) continue;
		const fork = await probe(signal => mergeBase(root, candidate.ref, "HEAD", signal));
		return { ref: candidate.ref, source: candidate.source, forkPoint: fork.ok ? fork.value : null };
	}
	return null;
}

/** Read the session-scoped git scene for `cwd`. */
export async function readGitContext(cwd: string, options: GitContextOptions = {}): Promise<GitContextResult> {
	const resolvedCwd = path.resolve(cwd);
	const limits: GitContextLimits = {
		maxFiles: clampInteger(options.maxFiles, GIT_CONTEXT_MAX_FILES, 1, 10_000),
		timeoutMs: clampInteger(options.timeoutMs, GIT_CONTEXT_TIMEOUT_MS, 100, 120_000),
	};
	const explicitBase = normalizeBaseRef(options.base);
	if (explicitBase === null) {
		return { available: false, cwd: resolvedCwd, reason: "invalid-base", detail: "base must be a ref name" };
	}

	const repository = await repo.resolve(resolvedCwd).catch(() => null);
	if (!repository) return { available: false, cwd: resolvedCwd, reason: "not-a-repository" };
	const root = repository.repoRoot;

	let timedOut = false;
	const probe = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<ProbeOutcome<T>> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
		timer.unref?.();
		try {
			return { ok: true, value: await run(controller.signal) };
		} catch (error) {
			if (controller.signal.aborted) {
				timedOut = true;
				return { ok: false, timedOut: true };
			}
			return { ok: false, timedOut: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
		}
	};

	const [statusOutcome, headOutcome, defaultBranchOutcome, upstreamOutcome] = await Promise.all([
		probe(signal => status(root, { porcelainV1: true, z: true, untrackedFiles: "all", signal })),
		probe(signal => head.resolve(root, signal)),
		probe(signal => branch.default(root, signal)),
		probe(signal => revList.aheadBehind(root, "HEAD", "@{upstream}", signal)),
	]);

	if (!statusOutcome.ok) {
		return statusOutcome.timedOut
			? { available: false, cwd: resolvedCwd, reason: "timeout", detail: "git status did not finish in time" }
			: { available: false, cwd: resolvedCwd, reason: "git-error", detail: statusOutcome.error };
	}

	const allEntries = parsePorcelainStatusV1Z(statusOutcome.value);
	const truncated = allEntries.length > limits.maxFiles;
	const entries = allEntries.slice(0, limits.maxFiles);
	const pathspecs = buildPathspecs(entries.map(entry => normalizePath(entry.path)));

	// `diff HEAD` reports staged and unstaged edits together, matching the status
	// rows. An unborn HEAD has nothing to diff against, so the index-to-empty-tree
	// view (`--cached`) stands in; untracked files are counted from disk either way.
	const numstatOutcome = await probe(async signal => {
		try {
			return await diff(root, { base: "HEAD", files: pathspecs, numstat: true, signal });
		} catch (error) {
			if (signal.aborted) throw error;
			return await diff(root, { cached: true, files: pathspecs, numstat: true, signal });
		}
	});

	const stats = new Map<string, GitNumstatRow>();
	if (numstatOutcome.ok) for (const row of parseNumstatRows(numstatOutcome.value)) stats.set(row.path, row);

	const headState = headOutcome.ok ? headOutcome.value : null;
	const headCommit = headState?.commit ?? null;
	const shortCommit = headCommit ? await probe(signal => head.short(root, 7, signal)) : null;

	const base = await resolveBase(
		root,
		explicitBase,
		defaultBranchOutcome.ok ? defaultBranchOutcome.value : null,
		probe,
	);

	const files = await Promise.all(
		entries.map(async (entry): Promise<GitContextFile> => {
			const file = normalizePath(entry.path);
			const stat = stats.get(file);
			const untracked = entry.status === "??";
			const additions = stat ? stat.additions : untracked ? await countUntrackedAdditions(root, file) : null;
			const deletions = stat ? stat.deletions : untracked ? 0 : null;
			return { path: file, status: entry.status, additions, deletions, kind: classifyChangeKind(file) };
		}),
	);

	const mainRoot = await repo.primaryRoot(root).catch(() => null);

	return {
		available: true,
		root,
		worktree: {
			linked: repository.gitDir !== repository.commonDir,
			gitDir: repository.gitDir,
			commonDir: repository.commonDir,
			mainRoot: mainRoot ?? root,
		},
		head: {
			branch: headState?.kind === "ref" ? headState.branchName : null,
			detached: headState?.kind === "detached",
			commit: headCommit,
			shortCommit: shortCommit?.ok ? shortCommit.value : null,
		},
		base,
		upstream: upstreamOutcome.ok ? upstreamOutcome.value : null,
		files,
		truncated,
		timedOut,
		limits,
	};
}
