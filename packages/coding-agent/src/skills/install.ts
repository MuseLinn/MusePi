/**
 * skills.install — install a skill folder from a git source into the
 * daemon's user-level skills directory (`<agentDir>/skills/<name>/`).
 *
 * v1 source contract (capability-center 设计板「能力中心」发现屏的安装动线):
 *   - `url`: an https git URL or a GitHub `owner/repo` slug
 *   - `subdir`: optional path inside the repo holding the SKILL.md
 *     (defaults: the repo root, else the unique recursive SKILL.md match)
 *   - `name`: optional target name (defaults to the SKILL.md frontmatter
 *     `name:`, then the containing folder name)
 *
 * The heavy lifting (clone → locate → copy) lives here so the daemon RPC
 * handler stays thin and the pure parts are unit-testable without network.
 * Local paths are also accepted (git clone of a local path), which keeps the
 * whole flow testable offline.
 */
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseGitUrl } from "../extensibility/plugins/git-url";

export interface InstallSkillOptions {
	url: string;
	subdir?: string;
	name?: string;
	/** User-level skills root (e.g. `<agentDir>/skills`). */
	destRoot: string;
	/** Replace an existing skill of the same name. Default: refuse. */
	overwrite?: boolean;
	/** Working directory for the git clone scratch. */
	cwd?: string;
	/** Accept plain local paths as the source. The daemon RPC keeps this OFF
	 *  (parseGitUrl is the gate against generic fetch-and-write); tests use
	 *  it to exercise the full flow offline. */
	allowLocalPath?: boolean;
	/** Abort the clone (kills the git process). Used by the marketplace
	 *  install state machine's cancel path. */
	signal?: AbortSignal;
}

export interface InstalledSkill {
	name: string;
	/** Absolute path of the installed skill folder. */
	dir: string;
}

/** Normalize the accepted source spellings to a git-cloneable URL. */
export function normalizeSkillSource(url: string): string {
	const trimmed = url.trim();
	// GitHub slug shorthand: "owner/repo" → the https clone URL.
	if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed) && !trimmed.startsWith(".")) {
		return `https://github.com/${trimmed}.git`;
	}
	return trimmed;
}

/** Locate the skill folder inside a cloned repo: explicit subdir first, then
 *  the root, then a unique recursive SKILL.md match (ambiguity = error). */
export function resolveSkillDir(root: string, subdir?: string): string | null {
	if (subdir) {
		const dir = path.join(root, subdir);
		return existsSync(path.join(dir, "SKILL.md")) ? dir : null;
	}
	if (existsSync(path.join(root, "SKILL.md"))) return root;
	const found: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 4) return;
		for (const entry of require("node:fs").readdirSync(dir, { withFileTypes: true }) as Array<{
			name: string;
			isDirectory: () => boolean;
		}>) {
			if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
			const child = path.join(dir, entry.name);
			if (existsSync(path.join(child, "SKILL.md"))) found.push(child);
			else walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return found.length === 1 ? found[0] : null;
}

/** `name:` from SKILL.md frontmatter; null when absent. */
export function parseSkillName(skillMd: string): string | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
	if (!match) return null;
	const name = /^name:\s*(.+)\s*$/m.exec(match[1]);
	const value = name?.[1]?.trim().replace(/^["']|["']$/g, "");
	return value || null;
}

/** Slug-safe target folder name: SKILL.md frontmatter name → folder name. */
export function skillTargetName(skillDir: string, explicit?: string): string {
	if (explicit?.trim()) return explicit.trim();
	const md = path.join(skillDir, "SKILL.md");
	if (existsSync(md)) {
		const { readFileSync } = require("node:fs") as typeof import("node:fs");
		const parsed = parseSkillName(readFileSync(md, "utf8"));
		if (parsed) return parsed;
	}
	return path.basename(skillDir);
}

/** Clone `url` shallowly and return the scratch dir (caller removes it).
 *  `signal` kills the git process on abort — the marketplace install state
 *  machine's cancel path rides this. */
export async function shallowClone(url: string, opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<string> {
	const scratch = await mkdtemp(path.join(tmpdir(), "musepi-skill-"));
	const proc = Bun.spawn(["git", "clone", "--depth", "1", url, path.join(scratch, "repo")], {
		cwd: opts.cwd,
		stdout: "ignore",
		stderr: "pipe",
	});
	let onAbort: (() => void) | undefined;
	if (opts.signal) {
		onAbort = () => {
			proc.kill();
		};
		opts.signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const exit = await proc.exited;
		if (exit !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`git clone failed: ${stderr.trim().slice(0, 300) || `exit ${exit}`}`);
		}
	} finally {
		if (onAbort && opts.signal) opts.signal.removeEventListener("abort", onAbort);
	}
	return scratch;
}

/** Resolve + copy half of the git installer, split from the clone so the
 *  clone can take an AbortSignal (marketplace install cancel path rides it).
 *  Caller owns the scratch dir. */
async function installFromClonedRepo(
	scratch: string,
	opts: { subdir?: string; name?: string; overwrite?: boolean; destRoot: string },
): Promise<InstalledSkill> {
	const repoDir = path.join(scratch, "repo");
	const skillDir = resolveSkillDir(repoDir, opts.subdir);
	if (!skillDir) {
		throw new Error(
			opts.subdir
				? `no SKILL.md under subdir "${opts.subdir}"`
				: "no SKILL.md found in the repo (root or single subdirectory expected)",
		);
	}
	const name = skillTargetName(skillDir, opts.name);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
		throw new Error(`derived skill name is not filesystem-safe: "${name}"`);
	}
	const dest = path.join(opts.destRoot, name);
	if (existsSync(dest) && !opts.overwrite) {
		throw new Error(`skill "${name}" already exists (pass overwrite to replace)`);
	}
	await cp(skillDir, dest, { recursive: true });
	return { name, dir: dest };
}

export async function installSkillFromGit(opts: InstallSkillOptions): Promise<InstalledSkill> {
	const source = normalizeSkillSource(opts.url);
	if (!source) throw new Error("url is required (https git URL or owner/repo)");
	// parseGitUrl is the guard against non-git junk (the marketplace's same
	// gate) — keeps `skills.install` from becoming a generic fetch-and-write
	// primitive. Local paths only with the explicit offline-testing flag.
	const parsed = opts.allowLocalPath ? { url: source } : parseGitUrl(source);
	if (!parsed) throw new Error(`not a git source: ${opts.url}`);

	const scratch = await shallowClone(source, { cwd: opts.cwd ?? process.cwd(), signal: opts.signal });
	try {
		return await installFromClonedRepo(scratch, opts);
	} finally {
		await rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}
