import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { expandAtImports } from "../discovery/at-imports.ts";
import { debug as logDebug, warn as logWarn } from "../utils/pi-logger.ts";
import { isEnoent } from "../utils/pi-utils.ts";
import { normalizePromptPath } from "../utils/prompt-path.ts";

// ── Template loading (module-level init, one read per file) ─────────────────

const currentDir = path.dirname(fileURLToPath(import.meta.url));
function loadTemplate(relativePath: string): string {
	return readFileSync(path.resolve(currentDir, relativePath), "utf8");
}

const activeRepoWatchdogTemplate = loadTemplate("../prompts/advisor/active-repo-watchdog.md");
const contextFilesTemplate = loadTemplate("../prompts/advisor/context-files.md");

// ── Inline helpers ──────────────────────────────────────────────────────────

/** Resolve the user agent directory (~/.omp). */
function getAgentDir(): string {
	return path.join(os.homedir(), ".omp");
}

/** Resolve the git repository root for a given working directory. */
async function getRepoRoot(cwd: string): Promise<string | null> {
	try {
		return await new Promise<string>((resolve, reject) => {
			execFile("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 }, (err, stdout) => {
				if (err) reject(err);
				else resolve(stdout.trim().replace(/\r?\n$/, ""));
			});
		});
	} catch {
		return null;
	}
}

// ── Minimal template renderer ({{var}} and {{#each list}}...{{/each}}) ──────

interface TemplateContext {
	[key: string]: unknown;
}

/**
 * Minimal template renderer that supports:
 * - `{{varName}}` — simple variable interpolation
 * - `{{#each list}}...{{/each}}` — iteration over arrays
 * - Nested `{{prop}}` inside each blocks, resolved against the iteration item
 */
function renderTemplate(template: string, context: TemplateContext): string {
	// Handle #each blocks first (recursive)
	const eachRegex = /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g;
	let result = template.replace(eachRegex, (_match, listName: string, body: string) => {
		const list = context[listName];
		if (!Array.isArray(list)) return "";
		return list
			.map((item: unknown) => {
				if (typeof item !== "object" || item === null) return "";
				const itemContext = item as Record<string, unknown>;
				return renderTemplate(body, itemContext);
			})
			.join("");
	});

	// Simple variable interpolation
	result = result.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
		const value = context[name];
		if (value === undefined || value === null) return "";
		return String(value);
	});

	return result;
}

// ── ActiveRepoContext type (inline; ported from @oh-my-pi utils) ────────────

export interface ActiveRepoContext {
	relativeRepoRoot: string;
}

// ── Exports ─────────────────────────────────────────────────────────────────

export function formatActiveRepoWatchdogPrompt(activeRepoContext: ActiveRepoContext): string {
	return renderTemplate(activeRepoWatchdogTemplate, {
		relativeRepoRoot: normalizePromptPath(activeRepoContext.relativeRepoRoot),
	}).trim();
}

/**
 * Render the project context files (AGENTS.md and the like) into a block for the
 * advisor's system prompt, mirroring how the primary agent receives them. Gives
 * the read-only reviewer the user's standing project instructions so it can hold
 * the driving agent to them instead of advising against project conventions it
 * cannot otherwise see. Returns undefined when there are no context files.
 */
export function formatAdvisorContextPrompt(
	contextFiles: ReadonlyArray<{ path: string; content: string }>,
): string | undefined {
	if (contextFiles.length === 0) return undefined;
	return renderTemplate(contextFilesTemplate, { contextFiles }).trim() || undefined;
}

/**
 * A readable config candidate discovered on the watchdog/advisor search path,
 * with raw (un-expanded) content and its position metadata.
 */
export interface ConfigCandidate {
	path: string;
	content: string;
	level: "user" | "project";
	depth: number;
}

/**
 * Walk the watchdog/advisor config search path — the user agent dir plus every
 * directory from `cwd` up to the repo root (or home), probing both `<F>` and
 * `.omp/<F>` for each given filename — and return the readable candidates with
 * their raw content, sorted user-first then project ancestor→leaf (depth
 * descending, so the leaf directory is most specific/last). Shared by
 * {@link discoverWatchdogFiles} and `discoverAdvisorConfigs`. Content is returned
 * verbatim (no `@import` expansion); callers expand what they need.
 */
export async function collectConfigCandidates(
	cwd: string,
	agentDir: string | undefined,
	filenames: string[],
): Promise<ConfigCandidate[]> {
	const home = os.homedir();
	const resolvedAgentDir = agentDir ?? getAgentDir();
	const userPaths = new Set<string>();
	let repoRoot: string | null = null;
	try {
		repoRoot = await getRepoRoot(cwd);
	} catch (err) {
		logDebug("Failed to resolve git root for config discovery", { err: String(err) });
	}

	const candidates = new Set<string>();

	// 1. User level: ~/.omp/<F> (or active profile agent dir)
	if (resolvedAgentDir) {
		for (const filename of filenames) {
			const userPath = path.resolve(resolvedAgentDir, filename);
			candidates.add(userPath);
			userPaths.add(userPath);
		}
	}

	// 2. Project levels (both standalone and native config .omp/): walk up from cwd to repoRoot / home
	let current = cwd;
	while (true) {
		for (const filename of filenames) {
			candidates.add(path.resolve(current, ".omp", filename));
			candidates.add(path.resolve(current, filename));
		}
		if (current === (repoRoot ?? home)) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	const items: ConfigCandidate[] = [];
	for (const candidate of candidates) {
		try {
			const content = await readFile(candidate, "utf8");
			const parent = path.dirname(candidate);
			const baseName = parent.split(path.sep).pop() ?? "";
			const isUser = userPaths.has(candidate);
			const ownerDir = baseName === ".omp" ? path.dirname(parent) : parent;
			const ownerBaseName = ownerDir.split(path.sep).pop() ?? "";
			if (isUser || !ownerBaseName.startsWith(".") || baseName === ".omp") {
				const relative = path.relative(cwd, ownerDir);
				const depth = relative === "" ? 0 : relative.split(path.sep).filter(Boolean).length;
				items.push({ path: candidate, content, level: isUser ? "user" : "project", depth });
			}
		} catch (err) {
			if (!isEnoent(err)) {
				logWarn("Failed to read config candidate", { path: candidate, error: String(err) });
			}
		}
	}

	// User level first, then project levels sorted by depth descending — ancestor
	// directories first, the leaf (depth 0) last/most prominent.
	items.sort((a, b) => {
		if (a.level !== b.level) return a.level === "user" ? -1 : 1;
		return b.depth - a.depth;
	});

	return items;
}

/**
 * Discover and load WATCHDOG.md files walking up from cwd, project .omp folder, and user agent dir.
 * Returns formatted watchdog file blocks ready to be appended to the advisor system prompt.
 */
export async function discoverWatchdogFiles(cwd: string, agentDir?: string): Promise<string[]> {
	const items = await collectConfigCandidates(cwd, agentDir, ["WATCHDOG.md"]);
	const blocks: string[] = [];
	for (const item of items) {
		const expanded = await expandAtImports(item.content, item.path);
		blocks.push(`Especially pay attention to:\n<attention>\n${expanded}\n</attention>`);
	}
	return blocks;
}
