import type { GhRunner } from "./github-mutations";

export interface GithubPrReviewComment {
	id: number;
	path: string;
	line: number | null;
	originalLine: number | null;
	startLine: number | null;
	originalStartLine: number | null;
	side: "LEFT" | "RIGHT" | null;
	startSide: "LEFT" | "RIGHT" | null;
	diffHunk: string;
	body: string;
	author: { login: string };
	createdAt?: string;
	inReplyToId: number | null;
	url: string;
	outdated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function line(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function side(value: unknown): "LEFT" | "RIGHT" | null {
	return value === "LEFT" || value === "RIGHT" ? value : null;
}

function normalizeReviewComment(value: unknown): GithubPrReviewComment | null {
	if (!isRecord(value)) return null;
	const id = line(value.id);
	const path = text(value.path)?.trim();
	const body = text(value.body);
	if (id === null || !path || body === undefined) return null;
	const currentLine = line(value.line);
	const originalLine = line(value.original_line);
	const user = isRecord(value.user) ? value.user : isRecord(value.author) ? value.author : null;
	return {
		id,
		path,
		line: currentLine,
		originalLine,
		startLine: line(value.start_line),
		originalStartLine: line(value.original_start_line),
		side: side(value.side),
		startSide: side(value.start_side),
		diffHunk: text(value.diff_hunk) ?? "",
		body,
		author: { login: (user && text(user.login)) || "unknown" },
		...(text(value.created_at) ? { createdAt: text(value.created_at) } : {}),
		inReplyToId: line(value.in_reply_to_id),
		url: text(value.html_url) ?? text(value.url) ?? "",
		outdated: currentLine === null && originalLine !== null,
	};
}

/** Accepts both a plain REST array and the array-of-pages produced by gh api --slurp. */
export function parseGithubPrReviewComments(stdout: string): GithubPrReviewComment[] {
	const parsed: unknown = JSON.parse(stdout);
	if (!Array.isArray(parsed)) throw new Error("invalid gh output");
	const rows = parsed.flatMap(page => (Array.isArray(page) ? page : [page]));
	return rows
		.map(normalizeReviewComment)
		.filter((comment): comment is GithubPrReviewComment => comment !== null)
		.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id);
}

export async function readGithubPrReviewComments(
	cwd: string,
	number: number,
	run: GhRunner,
): Promise<{ comments: GithubPrReviewComment[]; error?: string }> {
	const res = await run(cwd, [
		"api",
		"--paginate",
		"--slurp",
		`repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`,
	]);
	if (res.exitCode === null) return { comments: [], error: "gh CLI not installed" };
	if (res.exitCode !== 0) {
		return { comments: [], error: res.stderr.trim() || "gh pr review comments failed" };
	}
	try {
		return { comments: parseGithubPrReviewComments(res.stdout) };
	} catch {
		return { comments: [], error: "invalid gh review comment output" };
	}
}
