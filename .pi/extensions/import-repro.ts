/**
 * Import a pi session recorded by the issue-analysis CI workflow
 * (.github/workflows/issue-analysis.yml) and switch to it.
 *
 * The CI job runs in a high-entropy checkout directory; this command rewrites
 * the recorded cwd to the local checkout, installs the session file into the
 * current session directory, and switches to it.
 *
 * Usage (interactive command, also works as initial CLI message):
 *   /import-repro 123
 *   /import-repro #123
 *   /import-repro https://github.com/earendil-works/pi/issues/123
 *   /import-repro https://github.com/earendil-works/pi/actions/runs/123456789
 *   /import-repro /path/to/downloaded/session.jsonl
 *
 *   pi "/import-repro 123"
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const ISSUE_REF_RE = /^#?(\d+)$/;
const ISSUE_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/#?].*)?$/;
const RUN_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:[/#?].*)?$/;
const ARTIFACT_PREFIX = "pi-is-issue-";

interface ArtifactInfo {
	id: number;
	name: string;
	expired: boolean;
	created_at: string;
	workflow_run?: { id?: number };
}

interface SessionHeader {
	type: string;
	id: string;
	cwd: string;
}

function parseSessionHeader(raw: string): SessionHeader {
	const newlineIndex = raw.indexOf("\n");
	const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);
	let header: unknown;
	try {
		header = JSON.parse(firstLine);
	} catch {
		throw new Error("first line of session file is not valid JSON");
	}
	const h = header as Partial<SessionHeader>;
	if (h.type !== "session" || typeof h.id !== "string" || typeof h.cwd !== "string" || h.cwd === "") {
		throw new Error("session file has no valid session header with a cwd");
	}
	return h as SessionHeader;
}

/** Rewrite all occurrences of the recorded cwd (JSON-escaped) to the target cwd. */
function rewriteSessionCwd(raw: string, sourceCwd: string, targetCwd: string): string {
	if (sourceCwd === targetCwd) return raw;
	const escapeJson = (value: string) => JSON.stringify(value).slice(1, -1);
	return raw.split(escapeJson(sourceCwd)).join(escapeJson(targetCwd));
}

function findSessionFile(dir: string): string {
	const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
	const matches = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => join(entry.parentPath, entry.name));
	if (matches.length === 0) {
		throw new Error(`no .jsonl session file found in artifact (${dir})`);
	}
	if (matches.length > 1) {
		throw new Error(`multiple .jsonl files found in artifact: ${matches.join(", ")}`);
	}
	return matches[0];
}

export default function (pi: ExtensionAPI) {
	async function gh(args: string[], cwd: string): Promise<string> {
		const result = await pi.exec("gh", args, { cwd, timeout: 120_000 });
		if (result.code !== 0) {
			throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
		}
		return result.stdout;
	}

	async function resolveRepoSlug(cwd: string): Promise<string> {
		const output = await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd);
		const slug = output.trim();
		if (!slug) throw new Error("could not determine repository (gh repo view returned nothing)");
		return slug;
	}

	function pickArtifact(artifacts: ArtifactInfo[], filter: (name: string) => boolean): ArtifactInfo {
		const candidates = artifacts
			.filter((artifact) => !artifact.expired && filter(artifact.name))
			.sort((a, b) => b.created_at.localeCompare(a.created_at));
		if (candidates.length === 0) {
			throw new Error("no matching issue-analysis artifact found (expired or never uploaded?)");
		}
		return candidates[0];
	}

	/** Resolve a ref to a downloaded session .jsonl path. */
	async function fetchSessionFile(ref: string, cwd: string): Promise<string> {
		if (ref.endsWith(".jsonl")) {
			const path = isAbsolute(ref) ? ref : resolve(cwd, ref);
			if (!existsSync(path)) throw new Error(`session file not found: ${path}`);
			return path;
		}

		let repo: string;
		let artifact: ArtifactInfo;

		const runMatch = ref.match(RUN_URL_RE);
		const issueUrlMatch = ref.match(ISSUE_URL_RE);
		const issueRefMatch = ref.match(ISSUE_REF_RE);

		if (runMatch) {
			repo = runMatch[1];
			const runId = runMatch[2];
			const output = await gh(["api", `repos/${repo}/actions/runs/${runId}/artifacts`], cwd);
			const parsed = JSON.parse(output) as { artifacts: ArtifactInfo[] };
			artifact = pickArtifact(parsed.artifacts, (name) => name.startsWith(ARTIFACT_PREFIX));
		} else if (issueUrlMatch || issueRefMatch) {
			let issueNumber: string;
			if (issueUrlMatch) {
				repo = issueUrlMatch[1];
				issueNumber = issueUrlMatch[2];
			} else {
				repo = await resolveRepoSlug(cwd);
				issueNumber = (issueRefMatch as RegExpMatchArray)[1];
			}
			const output = await gh(["api", `repos/${repo}/actions/artifacts?per_page=100`], cwd);
			const parsed = JSON.parse(output) as { artifacts: ArtifactInfo[] };
			const namePattern = new RegExp(`^${ARTIFACT_PREFIX}${issueNumber}-run-\\d+$`);
			artifact = pickArtifact(parsed.artifacts, (name) => namePattern.test(name));
		} else {
			throw new Error(`unrecognized reference: ${ref} (expected issue number, issue URL, run URL, or .jsonl path)`);
		}

		const runId = artifact.workflow_run?.id;
		if (!runId) throw new Error(`artifact ${artifact.name} has no workflow run id`);

		const downloadDir = mkdtempSync(join(tmpdir(), "pi-import-repro-"));
		await gh(
			["run", "download", String(runId), "--repo", repo, "--name", artifact.name, "--dir", downloadDir],
			cwd,
		);
		return findSessionFile(downloadDir);
	}

	pi.registerCommand("import-repro", {
		description: "Import a CI issue-analysis session (issue number, issue/run URL, or .jsonl path) and switch to it",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const ref = args.trim();
			if (!ref) {
				ctx.ui.notify("Usage: /import-repro <issue number | issue URL | run URL | session.jsonl>", "error");
				return;
			}

			try {
				const targetCwd = ctx.sessionManager.getCwd();
				const sessionDir = ctx.sessionManager.getSessionDir();

				ctx.ui.notify(`Fetching session for ${ref}...`, "info");
				const sourceFile = await fetchSessionFile(ref, targetCwd);

				const raw = readFileSync(sourceFile, "utf8");
				const header = parseSessionHeader(raw);
				const rewritten = rewriteSessionCwd(raw, header.cwd, targetCwd);

				const destination = join(sessionDir, basename(sourceFile));
				if (existsSync(destination)) {
					const overwrite = await ctx.ui.confirm(
						"Session already imported",
						`Overwrite ${destination}? Local changes to that session will be lost.`,
					);
					if (!overwrite) {
						ctx.ui.notify("Import cancelled", "warning");
						return;
					}
				}
				writeFileSync(destination, rewritten);

				ctx.ui.notify(`Imported session ${header.id} (cwd ${header.cwd} -> ${targetCwd})`, "info");
				await ctx.switchSession(destination);
			} catch (error) {
				ctx.ui.notify(`import-repro: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
