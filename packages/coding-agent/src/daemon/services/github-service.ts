/**
 * GitHubService — the `github.*` surface (PR/issue center, gh auth, host
 * accounts) as an L2 daemon service.
 *
 * Seam:
 * - Input: `github.*` routes, the connection cwd, and the daemon-owned git
 *   account store (`git-accounts.ts`) plus its gh CLI runner (`github-cli.ts`).
 * - Output: the JSON shapes the PR/issue panes render, gh auth state, and
 *   connect/disconnect acks. Network failures come back as `{ error }` rather
 *   than throws so a flaky gh never fails the whole RPC batch.
 * - Lifecycle: stateless. The device-flow token lives in the account store,
 *   not in this service.
 */

import * as path from "node:path";
import {
	listGitAccounts,
	normalizeGitHost,
	removeGitAccount,
	upsertGitAccount,
	validateGitHubToken,
} from "../git-accounts";
import {
	classifyNetworkError,
	clearGhToken,
	friendlyNetworkError,
	ghPath,
	readGhToken,
	runGh,
	writeGhToken,
} from "../github-cli";
import { commentOnGithub, normalizeGithubReviewers, reviewOnGithub } from "../github-mutations";
import { readGithubPrReviewComments } from "../github-pr-review";
import type { DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

export class GitHubService implements DaemonService {
	readonly key = "github";
	readonly routes = {
		"github.prs": "prs",
		"github.prStatus": "prStatus",
		"github.issues": "issues",
		"github.prCreate": "prCreate",
		"github.prView": "prView",
		"github.prReview": "prReview",
		"github.prMerge": "prMerge",
		"github.prState": "prState",
		"github.prEdit": "prEdit",
		"github.issueView": "issueView",
		"github.issueState": "issueState",
		"github.issueComment": "issueComment",
		"github.prComment": "prComment",
		"github.authStatus": "authStatus",
		"github.authStart": "authStart",
		"github.authPoll": "authPoll",
		"github.accountList": "accountList",
		"github.patConnect": "patConnect",
		"github.accountRemove": "accountRemove",
		"github.authLogout": "authLogout",
	} as const;

	constructor(private readonly host: Pick<DaemonSessionHost, "cwd">) {}

	async prs(params: unknown): Promise<unknown> {
		// Pull-request list for the right-pane PR center. Uses the
		// `gh` CLI when available (same credentials the user's shell
		// has); reports a clear error otherwise. Extended fields
		// (checks rollup, mergeability, review decision) drive the
		// list's per-row status dots and the current-branch card.
		// `state` passes through to gh (open|closed|merged|all,
		// default open) for the board's state filter.
		const p = (params ?? {}) as { cwd?: string; state?: unknown };
		// Session cwd when the caller passes it (GUI PR pane) — the
		// host cwd is the daemon launch dir, which may be a different
		// repo (git RPC cwd-isolation parity).
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const stateRaw = typeof p.state === "string" ? p.state : "open";
		const state = ["open", "closed", "merged", "all"].includes(stateRaw) ? stateRaw : "open";
		const res = await runGh(cwd, [
			"pr",
			"list",
			"--state",
			state,
			"--limit",
			"50",
			"--json",
			"number,title,author,isDraft,state,headRefName,baseRefName,createdAt,updatedAt,url,comments,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision",
		]);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			const err = res.stderr.trim();
			return { error: err.includes("not found") ? "gh CLI not installed" : err || "gh unavailable" };
		}
		try {
			return { prs: JSON.parse(res.stdout) };
		} catch {
			return { error: "invalid gh output" };
		}
	}

	async prStatus(params: unknown): Promise<unknown> {
		// The PR belonging to the repo's CURRENT branch (gh resolves
		// the branch itself). No PR → { pr: null }, NOT an error —
		// the panel shows the create form there. 15s cap: network.
		const p = (params ?? {}) as { cwd?: string };
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const res = await runGh(cwd, [
			"pr",
			"view",
			"--json",
			"number,title,state,isDraft,url,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup",
		]);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			const err = res.stderr.trim();
			if (/no pull requests found|could not resolve|no pull request/i.test(err)) return { pr: null };
			return { error: err.includes("not found") ? "gh CLI not installed" : err || "gh unavailable" };
		}
		try {
			return { pr: JSON.parse(res.stdout) };
		} catch {
			return { error: "invalid gh output" };
		}
	}

	async issues(params: unknown): Promise<unknown> {
		// Issue list for the right-pane Issues subtab. `state` passes
		// through to gh (open|closed|all, default open); label and
		// author filters arrive from the pane's filter row.
		const p = (params ?? {}) as { cwd?: string; state?: unknown; label?: unknown; author?: unknown };
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const stateRaw = typeof p.state === "string" ? p.state : "open";
		const state = ["open", "closed", "all"].includes(stateRaw) ? stateRaw : "open";
		const args = [
			"issue",
			"list",
			"--state",
			state,
			"--limit",
			"50",
			"--json",
			"number,title,state,author,labels,updatedAt,url,comments",
		];
		if (typeof p.label === "string" && p.label.trim() !== "") args.push("--label", p.label.trim());
		if (typeof p.author === "string" && p.author.trim() !== "") args.push("--author", p.author.trim());
		const res = await runGh(cwd, args);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			const err = res.stderr.trim();
			return { error: err.includes("not found") ? "gh CLI not installed" : err || "gh unavailable" };
		}
		try {
			return { issues: JSON.parse(res.stdout) };
		} catch {
			return { error: "invalid gh output" };
		}
	}

	async prCreate(params: unknown): Promise<unknown> {
		// Create a PR for the repo's current branch. Push first via
		// git.push (the panel's button chains them); gh prints the
		// new PR's URL on stdout — parsed, not --json (field support
		// varies across gh versions).
		const p = (params ?? {}) as {
			cwd?: string;
			title?: unknown;
			body?: unknown;
			base?: unknown;
			draft?: unknown;
		};
		const title = typeof p.title === "string" ? p.title.trim() : "";
		if (!title) return { error: "title required" };
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const args = ["pr", "create", "--title", title];
		const body = typeof p.body === "string" ? p.body : "";
		args.push("--body", body || title);
		if (typeof p.base === "string" && p.base.trim() !== "") args.push("--base", p.base.trim());
		if (p.draft === true) args.push("--draft");
		const res = await runGh(cwd, args, 30_000);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			return { error: res.stderr.trim() || "gh pr create failed" };
		}
		const url = /https?:\/\/\S+/.exec(res.stdout)?.[0];
		return url ? { url } : { error: "gh pr create returned no URL" };
	}

	async prView(params: unknown): Promise<unknown> {
		// Single-PR detail for the board's preview pane: body, comments,
		// reviews, labels, reviewers/assignees — everything the list
		// row doesn't carry. `no pull requests found` → { pr: null }.
		const p = (params ?? {}) as { cwd?: string; number?: unknown };
		const num = Number(p.number);
		if (!Number.isInteger(num) || num <= 0) return { error: "number required" };
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const [res, review] = await Promise.all([
			runGh(cwd, [
				"pr",
				"view",
				String(num),
				"--json",
				"number,title,body,author,state,isDraft,url,labels,reviewRequests,assignees,milestone,comments,reviews,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision,headRefName,baseRefName,createdAt,updatedAt,closedAt",
			]),
			readGithubPrReviewComments(cwd, num, runGh),
		]);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			const err = res.stderr.trim();
			if (/no pull requests found|could not resolve|no pull request/i.test(err)) return { pr: null };
			return { error: err.includes("not found") ? "gh CLI not installed" : err || "gh unavailable" };
		}
		try {
			const pr = JSON.parse(res.stdout) as {
				reviewRequests?: { login?: string; slug?: string; name?: string }[];
			};
			return {
				pr: {
					...pr,
					reviewers: normalizeGithubReviewers(pr.reviewRequests),
					reviewComments: review.comments,
					...(review.error ? { reviewCommentsError: review.error } : {}),
				},
			};
		} catch {
			return { error: "invalid gh output" };
		}
	}

	async prReview(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; number?: unknown; event?: unknown; body?: unknown };
		if (p.event !== "approve" && p.event !== "request-changes") return { error: "review event required" };
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		return reviewOnGithub(cwd, Number(p.number), p.event, typeof p.body === "string" ? p.body : "", runGh);
	}

	async prMerge(params: unknown): Promise<unknown> {
		// Merge a PR from the board preview (method picker → confirm).
		// 30s cap: gh may push the merge commit and delete nothing (the
		// branch is kept — deletion surprises users mid-work).
		const p = (params ?? {}) as { cwd?: string; number?: unknown; method?: unknown };
		const num = Number(p.number);
		if (!Number.isInteger(num) || num <= 0) return { error: "number required" };
		const methodRaw = typeof p.method === "string" ? p.method : "merge";
		const method = ["merge", "squash", "rebase"].includes(methodRaw) ? methodRaw : "merge";
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const res = await runGh(cwd, ["pr", "merge", String(num), `--${method}`], 30_000);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			return { error: res.stderr.trim() || "gh pr merge failed" };
		}
		return { ok: true };
	}

	async prState(params: unknown): Promise<unknown> {
		// Close or reopen a PR from the board preview.
		const p = (params ?? {}) as { cwd?: string; number?: unknown; state?: unknown };
		const num = Number(p.number);
		if (!Number.isInteger(num) || num <= 0) return { error: "number required" };
		const state = p.state === "open" ? "reopen" : "close";
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const res = await runGh(cwd, ["pr", state, String(num)]);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			return { error: res.stderr.trim() || `gh pr ${state} failed` };
		}
		return { ok: true };
	}

	async prEdit(params: unknown): Promise<unknown> {
		// Label / reviewer edits from the board preview. Every list is
		// optional; nothing to do is a no-op success.
		const p = (params ?? {}) as {
			cwd?: string;
			number?: unknown;
			addLabels?: unknown;
			removeLabels?: unknown;
			addReviewers?: unknown;
			removeReviewers?: unknown;
		};
		const num = Number(p.number);
		if (!Number.isInteger(num) || num <= 0) return { error: "number required" };
		const list = (v: unknown): string[] =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
		const addLabels = list(p.addLabels);
		const removeLabels = list(p.removeLabels);
		const addReviewers = list(p.addReviewers);
		const removeReviewers = list(p.removeReviewers);
		if (addLabels.length + removeLabels.length + addReviewers.length + removeReviewers.length === 0) {
			return { ok: true };
		}
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const args = ["pr", "edit", String(num)];
		for (const l of addLabels) args.push("--add-label", l);
		for (const l of removeLabels) args.push("--remove-label", l);
		for (const r of addReviewers) args.push("--add-reviewer", r);
		for (const r of removeReviewers) args.push("--remove-reviewer", r);
		const res = await runGh(cwd, args);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			return { error: res.stderr.trim() || "gh pr edit failed" };
		}
		return { ok: true };
	}

	async issueView(params: unknown): Promise<unknown> {
		// Single-issue detail for the issues tab preview: body, labels,
		// assignees, comments. `no issues found` → { issue: null }.
		const p = (params ?? {}) as { cwd?: string; number?: unknown };
		const num = Number(p.number);
		if (!Number.isInteger(num) || num <= 0) return { error: "number required" };
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const res = await runGh(cwd, [
			"issue",
			"view",
			String(num),
			"--json",
			"number,title,body,state,author,labels,assignees,comments,url,createdAt,updatedAt,closedAt",
		]);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			const err = res.stderr.trim();
			if (/no issues found/i.test(err)) return { issue: null };
			return { error: err.includes("not found") ? "gh CLI not installed" : err || "gh unavailable" };
		}
		try {
			return { issue: JSON.parse(res.stdout) };
		} catch {
			return { error: "invalid gh output" };
		}
	}

	async issueState(params: unknown): Promise<unknown> {
		// Close or reopen an issue from the issues tab preview.
		const p = (params ?? {}) as { cwd?: string; number?: unknown; state?: unknown };
		const num = Number(p.number);
		if (!Number.isInteger(num) || num <= 0) return { error: "number required" };
		const state = p.state === "open" ? "reopen" : "close";
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		const res = await runGh(cwd, ["issue", state, String(num)]);
		if (res.exitCode === null) return { error: "gh CLI not installed" };
		if (res.exitCode !== 0) {
			return { error: res.stderr.trim() || `gh issue ${state} failed` };
		}
		return { ok: true };
	}

	async issueComment(params: unknown): Promise<unknown> {
		return this.#comment("issue", params);
	}

	async prComment(params: unknown): Promise<unknown> {
		return this.#comment("pr", params);
	}

	async #comment(kind: "issue" | "pr", params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { cwd?: string; number?: unknown; body?: unknown };
		const cwd = p.cwd && p.cwd.trim() !== "" ? path.resolve(p.cwd) : this.host.cwd();
		return commentOnGithub(cwd, kind, Number(p.number), typeof p.body === "string" ? p.body : "", runGh);
	}

	async authStatus(params: unknown): Promise<unknown> {
		// gh CLI auth state (settings Git tab): login/active account +
		// email. Async spawn + 10s cap — a hung gh (keyring lock) must
		// not freeze the GUI. `gh auth status --json` field names vary
		// across gh versions, so use the text form + `gh api user`.
		const run = async (
			args: string[],
			env?: Record<string, string>,
		): Promise<{ exit: number; out: string; err: string }> => {
			const gh = ghPath();
			if (gh === null) return { exit: -1, out: "", err: "gh CLI not installed" };
			const proc = Bun.spawn({ cmd: [gh, ...args], stdout: "pipe", stderr: "pipe", env, windowsHide: true });
			setTimeout(() => {
				try {
					proc.kill();
				} catch {
					// already exited
				}
			}, 10_000);
			const [exit, out, err] = await Promise.all([
				proc.exited.catch(() => null),
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { exit: exit ?? -1, out, err };
		};
		// Daemon-owned token wins: it was saved
		// by the device flow and needs no api.github.com round-trip to
		// be trusted. The keyring (gh CLI manual login) is the
		// fallback path below.
		const stored = readGhToken();
		if (stored) {
			// No blocking network: the device flow already stored
			// login/email (this machine can reach github.com but
			// api.github.com is flaky). Refresh identity in the
			// background; the GUI is not kept waiting.
			void (async () => {
				const who = await run(["api", "user", "--jq", '.login + "\\u0000" + (.email // "")'], {
					...process.env,
					GH_TOKEN: stored.token,
				});
				if (who.exit !== 0) return;
				const [apiLogin, mail] = who.out.trim().split("\0");
				if (!apiLogin) return;
				writeGhToken(stored.token, { login: apiLogin, email: mail || undefined });
			})();
			return {
				installed: true,
				authenticated: true,
				login: stored.login,
				email: stored.email || undefined,
				// Avatar is derived from the login (github.com/<login>.png),
				// not fetched — api.github.com may be unreachable but
				// github.com itself works (device flow proves it).
				avatarUrl: stored.login ? `https://github.com/${stored.login}.png` : undefined,
				active: true,
				source: "oauth",
				updatedAt: stored.updatedAt,
			};
		}
		if (ghPath() === null) return { installed: false };
		const status = await run(["auth", "status"]);
		if (status.exit !== 0) {
			return { installed: true, authenticated: false, detail: status.err.trim() || status.out.trim() };
		}
		// "Logged in to github.com account MuseLinn (keyring)"
		const loginMatch = /Logged in to github\.com account (\S+)/.exec(status.out);
		const who = await run(["api", "user", "--jq", '.login + "\\u0000" + (.email // "")']);
		let login = loginMatch?.[1];
		let email = "";
		if (who.exit === 0) {
			const [apiLogin, mail] = who.out.trim().split("\0");
			if (apiLogin) login = apiLogin;
			email = mail;
		}
		return {
			installed: true,
			authenticated: true,
			login,
			email: email || undefined,
			avatarUrl: login ? `https://github.com/${login}.png` : undefined,
			active: true,
			source: "gh-cli",
		};
	}

	async authStart(params: unknown): Promise<unknown> {
		// GitHub OAuth device flow (same public client the gh CLI
		// ships): returns a user code + verification URL the GUI shows,
		// then polls github.authPoll until the user authorizes.
		let resp: Response;
		try {
			resp = await fetch("https://github.com/login/device/code", {
				method: "POST",
				headers: { Accept: "application/json" },
				body: new URLSearchParams({
					client_id: "178c6fc778ccc68e1d6a",
					scope: "repo read:org gist workflow",
				}),
			});
		} catch (err) {
			return { error: friendlyNetworkError(err) };
		}
		if (!resp.ok) return { error: `device flow start failed (${resp.status})` };
		const body = (await resp.json()) as {
			device_code?: string;
			user_code?: string;
			verification_uri?: string;
			expires_in?: number;
			interval?: number;
			error?: string;
		};
		if (body.error || !body.device_code) return { error: body.error ?? "device flow start failed" };
		return {
			deviceCode: body.device_code,
			userCode: body.user_code,
			verificationUri: body.verification_uri,
			expiresIn: body.expires_in ?? 899,
			interval: body.interval ?? 5,
		};
	}

	async authPoll(params: unknown): Promise<unknown> {
		// Poll the device-flow authorization; on success the token is
		// imported into the gh keyring (gh auth login --with-token) so
		// every existing gh-based RPC picks it up.
		const p = (params ?? {}) as { deviceCode?: string; interval?: number };
		if (!p.deviceCode) throw new Error("deviceCode required");
		let poll: Response;
		try {
			poll = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: { Accept: "application/json" },
				body: new URLSearchParams({
					client_id: "178c6fc778ccc68e1d6a",
					device_code: p.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
			});
		} catch (err) {
			// Transient network hiccup → keep polling (GitHub device
			// flow guidance); fatal TLS errors surface clearly.
			if (classifyNetworkError(err) === "transient") {
				return { pending: true, interval: Math.max(10, (p.interval ?? 5) + 5) };
			}
			return { error: friendlyNetworkError(err) };
		}
		const body = (await poll.json()) as { access_token?: string; error?: string; error_description?: string };
		if (body.error === "authorization_pending" || body.error === "slow_down") {
			return {
				pending: true,
				interval: Math.max(5, (p.interval ?? 5) + (body.error === "slow_down" ? 5 : 0)),
			};
		}
		if (body.error) return { error: body.error_description ?? body.error };
		if (!body.access_token) return { error: "no access token" };
		// Persist the token daemon-side instead
		// of `gh auth login --with-token` (whose validation requests
		// api.github.com and fails the whole flow on flaky networks).
		// gh RPCs receive it via GH_TOKEN env.
		writeGhToken(body.access_token);
		// Best-effort identity for the UI; unreachable api.github.com
		// is tolerated — the token itself is already valid.
		const gh = ghPath();
		if (gh !== null) {
			const who = Bun.spawnSync({
				cmd: [gh, "api", "user", "--jq", '.login + "\\u0000" + (.email // "")'],
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GH_TOKEN: body.access_token },
				windowsHide: true,
			});
			if (who.exitCode === 0) {
				const [login, email] = who.stdout.toString().trim().split("\0");
				// Attach the identity to the account the basic write just
				// created; a failed write here keeps the token-only account.
				writeGhToken(body.access_token, { login, email: email || undefined });
				return { connected: true, login: login || undefined };
			}
		}
		return { connected: true };
	}

	async accountList(params: unknown): Promise<unknown> {
		// Connected git-host accounts for the settings UI — tokens
		// are masked (…last4); the raw credential never leaves
		// git-accounts.ts except via GH_TOKEN-spawning RPCs.
		return { accounts: listGitAccounts() };
	}

	async patConnect(params: unknown): Promise<unknown> {
		// PAT 直接接入（GitHub Enterprise / 自托管兼容主机）：校验
		// 通过才落库，新账号成为该主机的活跃凭据。
		const p = (params ?? {}) as { host?: string; token?: string };
		const token = typeof p.token === "string" ? p.token.trim() : "";
		if (!token) return { error: "token required" };
		const host = normalizeGitHost(p.host ?? "github.com") || "github.com";
		const validated = await validateGitHubToken(host, token);
		if ("error" in validated) return { error: validated.error };
		const account = upsertGitAccount({
			host,
			kind: "github",
			token,
			login: validated.login,
			email: validated.email,
		});
		return { connected: true, id: account.id, login: account.login };
	}

	async accountRemove(params: unknown): Promise<unknown> {
		const p = (params ?? {}) as { id?: string };
		if (typeof p.id !== "string" || !p.id) return { error: "id required" };
		return { ok: removeGitAccount(p.id) };
	}

	async authLogout(params: unknown): Promise<unknown> {
		// Drop the daemon-owned token; also
		// best-effort `gh auth logout --yes` for a keyring login the
		// user made via the gh CLI directly. 10s cap on the gh spawn.
		clearGhToken();
		const gh = ghPath();
		if (gh === null) return { ok: true };
		const proc = Bun.spawn({
			cmd: [gh, "auth", "logout", "--hostname", "github.com", "--yes"],
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		setTimeout(() => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
		}, 10_000);
		const [exit, err] = await Promise.all([proc.exited.catch(() => null), new Response(proc.stderr).text()]);
		return { ok: exit === 0, detail: exit === 0 ? undefined : err.trim() };
	}
}
