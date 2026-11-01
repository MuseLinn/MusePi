import { describe, expect, test } from "bun:test";
import {
	commentOnGithub,
	type GhResult,
	normalizeGithubReviewers,
	reviewOnGithub,
} from "../../src/daemon/github-mutations";

function runner(result: GhResult): { run: (cwd: string, args: string[]) => Promise<GhResult>; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: async (_cwd, args) => {
			calls.push(args);
			return result;
		},
	};
}

describe("GitHub comment mutations", () => {
	test("posts issue and pull-request comments through gh", async () => {
		const { run, calls } = runner({ exitCode: 0, stdout: "", stderr: "" });
		expect(await commentOnGithub("/repo", "issue", 42, "Issue note", run)).toEqual({ ok: true });
		expect(await commentOnGithub("/repo", "pr", 43, "PR note", run)).toEqual({ ok: true });
		expect(calls).toEqual([
			["issue", "comment", "42", "--body", "Issue note"],
			["pr", "comment", "43", "--body", "PR note"],
		]);
	});

	test("rejects blank comments without invoking gh", async () => {
		const { run, calls } = runner({ exitCode: 0, stdout: "", stderr: "" });
		expect(await commentOnGithub("/repo", "issue", 42, "  \n", run)).toEqual({ error: "comment required" });
		expect(calls).toEqual([]);
	});

	test("surfaces gh's failure reason", async () => {
		const { run } = runner({ exitCode: 2, stdout: "", stderr: "comment rejected" });
		expect(await commentOnGithub("/repo", "pr", 43, "PR note", run)).toEqual({ error: "comment rejected" });
	});

	test("submits an approval without a body and a change request with one", async () => {
		const { run, calls } = runner({ exitCode: 0, stdout: "", stderr: "" });
		expect(await reviewOnGithub("/repo", 43, "approve", "  ", run)).toEqual({ ok: true });
		expect(await reviewOnGithub("/repo", 43, "request-changes", " Add coverage ", run)).toEqual({ ok: true });
		expect(calls).toEqual([
			["pr", "review", "43", "--approve"],
			["pr", "review", "43", "--request-changes", "--body", "Add coverage"],
		]);
	});

	test("requires a reason for change requests before invoking gh", async () => {
		const { run, calls } = runner({ exitCode: 0, stdout: "", stderr: "" });
		expect(await reviewOnGithub("/repo", 43, "request-changes", " \n", run)).toEqual({
			error: "review body required",
		});
		expect(calls).toEqual([]);
	});

	test("normalizes user and team review requests into removable reviewer names", () => {
		expect(
			normalizeGithubReviewers([
				{ login: "octo" },
				{ slug: "team-octo", name: "Octo Team" },
				{ name: "fallback-name" },
				{},
			]),
		).toEqual([{ login: "octo" }, { login: "team-octo" }, { login: "fallback-name" }]);
	});
});
