import { describe, expect, test } from "bun:test";
import type { GhRunner } from "./github-mutations";
import { parseGithubPrReviewComments, readGithubPrReviewComments } from "./github-pr-review";

const root = {
	id: 10,
	path: "src/editor.ts",
	line: 42,
	original_line: 42,
	start_line: 40,
	original_start_line: 40,
	side: "RIGHT",
	start_side: "RIGHT",
	diff_hunk: "@@ -40,3 +40,3 @@\n const editor = true;",
	body: "Keep this focused.",
	user: { login: "reviewer" },
	created_at: "2026-10-31T10:00:00Z",
	html_url: "https://github.com/o/r/pull/7#discussion_r10",
};

describe("GitHub PR review comments", () => {
	test("flattens pages, preserves code positions, and skips malformed entries", () => {
		const comments = parseGithubPrReviewComments(
			JSON.stringify([
				[root, { id: "bad" }],
				[
					{
						...root,
						id: 11,
						body: "Reply",
						created_at: "2026-10-31T10:01:00Z",
						in_reply_to_id: 10,
					},
					{
						...root,
						id: 12,
						line: null,
						original_line: 17,
						body: "Outdated",
						created_at: "2026-10-31T10:02:00Z",
					},
				],
			]),
		);

		expect(comments.map(comment => comment.id)).toEqual([10, 11, 12]);
		expect(comments[0]).toMatchObject({
			path: "src/editor.ts",
			line: 42,
			originalLine: 42,
			startLine: 40,
			side: "RIGHT",
			author: { login: "reviewer" },
			outdated: false,
		});
		expect(comments[1]?.inReplyToId).toBe(10);
		expect(comments[2]?.outdated).toBe(true);
	});

	test("requests every page through the repository-aware gh endpoint", async () => {
		let call: { cwd: string; args: string[] } | null = null;
		const run: GhRunner = async (cwd, args) => {
			call = { cwd, args };
			return { exitCode: 0, stdout: JSON.stringify([[root]]), stderr: "" };
		};

		const result = await readGithubPrReviewComments("/repo", 7, run);

		expect(call as { cwd: string; args: string[] } | null).toEqual({
			cwd: "/repo",
			args: ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/pulls/7/comments?per_page=100"],
		});
		expect(result.error).toBeUndefined();
		expect(result.comments).toHaveLength(1);
	});

	test("reports an inline-comment failure without inventing an empty success", async () => {
		const run: GhRunner = async () => ({ exitCode: 1, stdout: "", stderr: "offline" });
		expect(await readGithubPrReviewComments("/repo", 7, run)).toEqual({ comments: [], error: "offline" });
	});

	test("reports invalid JSON separately from a valid empty page", async () => {
		const run: GhRunner = async () => ({ exitCode: 0, stdout: "not json", stderr: "" });
		expect(await readGithubPrReviewComments("/repo", 7, run)).toEqual({
			comments: [],
			error: "invalid gh review comment output",
		});
	});
});
