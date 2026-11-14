import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GitPanel } from "../src/components/git-panel";
import type { RpcClient } from "../src/lib/rpc";

interface Call {
	method: string;
	params?: Record<string, unknown>;
}

type GitContextPayload = Record<string, unknown>;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	localStorage.setItem("musepi-gui-git-view", "flat");
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	localStorage.removeItem("musepi-gui-git-view");
});

function contextFixture(overrides: GitContextPayload = {}): GitContextPayload {
	return {
		available: true,
		root: "/repo",
		worktree: { linked: false, gitDir: "/repo/.git", commonDir: "/repo/.git", mainRoot: "/repo" },
		head: {
			branch: "feature/review",
			detached: false,
			commit: "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			shortCommit: "1111111",
		},
		base: { ref: "refs/heads/main", source: "local", forkPoint: "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
		upstream: { ahead: 2, behind: 1 },
		files: [
			{ path: "src/b.ts", status: " M", additions: 3, deletions: 1, kind: "code" },
			{ path: "src/a.ts", status: "M ", additions: 5, deletions: 0, kind: "code" },
			{ path: "test/x.test.ts", status: "??", additions: 10, deletions: 0, kind: "test" },
			{ path: "docs/readme.md", status: " M", additions: 1, deletions: 2, kind: "docs" },
		],
		truncated: false,
		timedOut: false,
		limits: { maxFiles: 2000, timeoutMs: 10_000 },
		...overrides,
	};
}

function rpcWithContext(payload: GitContextPayload | (() => GitContextPayload)): {
	rpc: RpcClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
		calls.push({ method, params });
		if (method === "git.context") return Promise.resolve(typeof payload === "function" ? payload() : payload);
		if (method === "git.diff") return Promise.resolve({ staged: "", unstaged: "" });
		return Promise.resolve({});
	};
	return { rpc: { request } as unknown as RpcClient, calls };
}

async function flush(): Promise<void> {
	await act(async () => {
		await Bun.sleep(0);
	});
}

async function render(rpc: RpcClient): Promise<void> {
	await act(async () => {
		root.render(createElement(GitPanel, { rpc, cwd: "/repo" }));
	});
	await flush();
	await flush();
}

function fileRowButtons(): HTMLButtonElement[] {
	return [...host.querySelectorAll<HTMLButtonElement>("button.gui-changes-row:not(.gui-changes-row--dir)")];
}

describe("git panel changes view", () => {
	test("reads git.context and groups changed files by kind", async () => {
		const { rpc, calls } = rpcWithContext(
			contextFixture({
				truncated: true,
				worktree: {
					linked: true,
					gitDir: "/repo/.git/worktrees/wt",
					commonDir: "/repo/.git",
					mainRoot: "/repo",
				},
			}),
		);
		await render(rpc);

		expect(calls.find(call => call.method === "git.context")?.params).toEqual({ cwd: "/repo" });

		const headers = [...host.querySelectorAll<HTMLButtonElement>("button.gui-changes-row--dir")].map(
			button => button.textContent ?? "",
		);
		expect(headers.length).toBe(3);
		expect(headers[0]).toContain("Code");
		expect(headers[0]).toContain("2");
		expect(headers[0]).toContain("+8");
		expect(headers[0]).toContain("−1");
		expect(headers[1]).toContain("Tests");
		expect(headers[1]).toContain("+10");
		expect(headers[2]).toContain("Docs");

		const rows = fileRowButtons().map(button => button.textContent ?? "");
		expect(rows[0]).toContain("src/a.ts");
		expect(rows[1]).toContain("src/b.ts");
		expect(rows[2]).toContain("test/x.test.ts");

		const text = host.textContent ?? "";
		expect(text).toContain("feature/review");
		expect(text).toContain("↑2");
		expect(text).toContain("↓1");
		expect(text).toContain("main");
		expect(text).toContain("@2222222");
		expect(text).toContain("Worktree");
		expect(text).toContain("Truncated");
	});

	test("a detached HEAD shows the short sha and no divergence", async () => {
		const { rpc } = rpcWithContext(
			contextFixture({
				head: {
					branch: null,
					detached: true,
					commit: "abcdef0123456789abcdef0123456789abcdef01",
					shortCommit: "abcdef0",
				},
				base: null,
				upstream: null,
			}),
		);
		await render(rpc);

		const text = host.textContent ?? "";
		expect(text).toContain("abcdef0");
		expect(text).not.toContain("↑");
		expect(text).not.toContain("↓");
		expect(host.querySelector('[title="Detached HEAD"]')).not.toBeNull();
		expect(host.querySelector('use[href="#oc-git-fork"]')).toBeNull();
	});

	test("an unavailable snapshot renders a structured error with retry", async () => {
		let payload: GitContextPayload = {
			available: false,
			cwd: "/repo",
			reason: "timeout",
			detail: "git status did not finish in time",
		};
		const { rpc, calls } = rpcWithContext(() => payload);
		await render(rpc);

		expect(host.textContent).toContain("Timed out");
		expect(host.textContent).toContain("git status did not finish in time");
		const retry = host.querySelector<HTMLButtonElement>(".gui-pane-action");
		expect(retry).not.toBeNull();

		payload = { available: false, cwd: "/repo", reason: "not-a-repository" };
		await act(async () => retry?.click());
		await flush();
		await flush();

		expect(calls.filter(call => call.method === "git.context").length).toBe(2);
		expect(host.textContent).toContain("Not a Git directory");
	});

	test("clicking a file opens its diff through git.diff", async () => {
		const { rpc, calls } = rpcWithContext(contextFixture());
		await render(rpc);

		const row = fileRowButtons().find(button => button.textContent?.includes("src/a.ts"));
		expect(row).toBeDefined();
		await act(async () => row?.click());
		await flush();

		expect(calls.find(call => call.method === "git.diff")?.params).toMatchObject({
			path: "src/a.ts",
			cwd: "/repo",
		});
	});
});
