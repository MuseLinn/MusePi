import "./happy-dom-shim";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PrCenter } from "../src/components/pr-center";
import type { RpcClient } from "../src/lib/rpc";

interface Call {
	method: string;
	params?: Record<string, unknown>;
}

interface IssueFixture {
	number: number;
	title: string;
	state: string;
	author: { login: string };
	labels: { name: string; color: string }[];
	updatedAt: string;
	createdAt: string;
	closedAt: string | null;
	url: string;
	body: string;
	assignees: { login: string }[];
	comments: { author: { login: string }; body: string; createdAt: string }[];
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value?: T | PromiseLike<T>): void;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	localStorage.setItem("musepi-gui-prcenter-tab", "issues");
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	localStorage.removeItem("musepi-gui-prcenter-tab");
	globalThis.ResizeObserver = OriginalResizeObserver;
	vi.restoreAllMocks();
});
const OriginalResizeObserver = globalThis.ResizeObserver;
afterAll(() => {
	globalThis.ResizeObserver = OriginalResizeObserver;
});

function mockBoardWidth(width: number): void {
	class Observer {
		constructor(readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
		observe(): void {
			this.callback([{ contentRect: { width } }]);
		}
		disconnect(): void {}
	}
	globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
}

function issue(number: number): IssueFixture {
	return {
		number,
		title: `Issue ${number}`,
		state: "OPEN",
		author: { login: "octocat" },
		labels: [],
		updatedAt: "2026-10-24T00:00:00Z",
		createdAt: "2026-10-24T00:00:00Z",
		closedAt: null,
		url: `https://github.com/o/r/issues/${number}`,
		body: number === 1 ? "**Bold body**" : "Second body",
		assignees: [],
		comments: [],
	};
}

function rpcWithDetails(
	detailRequests: Array<Deferred<{ issue: IssueFixture }> | undefined>,
	commentRequest?: Deferred<{ ok: boolean }>,
): { rpc: RpcClient; calls: Call[] } {
	const calls: Call[] = [];
	let detailIndex = 0;
	const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
		calls.push({ method, params });
		if (method === "github.issues") return Promise.resolve({ issues: [issue(1), issue(2)] });
		if (method === "github.issueView") {
			const number = Number(params?.number ?? 1);
			const pending = detailRequests[detailIndex++];
			if (pending) return pending.promise;
			return Promise.resolve({ issue: issue(number) });
		}
		if (method === "github.issueComment") {
			if (commentRequest) return commentRequest.promise;
			return Promise.resolve({ ok: true });
		}
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
		root.render(createElement(PrCenter, { rpc, cwd: "/repo" }));
	});
	await flush();
	await flush();
}

async function typeComment(text: string): Promise<void> {
	const composer = host.querySelector<HTMLTextAreaElement>(".gui-pr-comment-composer textarea")!;
	const propsKey = Object.keys(composer).find(key => key.startsWith("__reactProps$"))!;
	const props = (composer as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
	composer.value = text;
	await act(async () => props.onChange({ target: composer, currentTarget: composer }));
}

describe("PrCenter issue workspace", () => {
	test("groups search and surface tabs in one toolbar", async () => {
		const { rpc } = rpcWithDetails([]);
		await render(rpc);
		const toolbar = host.querySelector(".gui-pr-toolbar");
		expect(toolbar).not.toBeNull();
		expect(toolbar?.querySelector(".gui-pr-search")).not.toBeNull();
		expect(toolbar?.querySelector(".gui-pane-subtabs")).not.toBeNull();
	});

	test("keeps the workspace in a constrained flex column for independent scrolling", async () => {
		const { rpc } = rpcWithDetails([]);
		await render(rpc);
		const workspace = host.querySelector(".gui-pr-workspace");
		expect(workspace?.parentElement?.classList.contains("gui-pr-pane")).toBe(true);
		expect(workspace?.parentElement?.parentElement?.classList.contains("flex")).toBe(true);
		expect(workspace?.parentElement?.parentElement?.classList.contains("flex-col")).toBe(true);
		expect(workspace?.parentElement?.parentElement?.classList.contains("min-h-0")).toBe(true);
	});

	test("selects the first issue and renders its Markdown detail", async () => {
		const { rpc } = rpcWithDetails([]);
		await render(rpc);
		expect(host.querySelector(".gui-pr-detail")?.textContent).toContain("Issue 1");
		expect(host.querySelector(".gui-pr-detail-title")).not.toBeNull();
		expect(host.querySelector(".gui-pr-detail-body strong")?.textContent).toBe("Bold body");
		expect(host.querySelector(".gui-pr-filter-row .gui-group-label") === null).toBe(true);
	});

	test("narrow boards keep the detail and open the list as a popup", async () => {
		mockBoardWidth(700);
		const { rpc } = rpcWithDetails([]);
		await render(rpc);
		expect(host.querySelector(".gui-pr-workspace--narrow") !== null).toBe(true);
		expect(host.querySelector(".gui-pr-workspace > .gui-pr-list") === null).toBe(true);
		const toggle = host.querySelector<HTMLButtonElement>(".gui-pr-list-toggle")!;
		await act(async () => toggle.click());
		const rows = document.body.querySelectorAll<HTMLButtonElement>(".gui-pr-list-popup .gui-pr-list-row");
		expect(rows.length).toBe(2);
		await act(async () => rows[1]?.click());
		await act(async () => Bun.sleep(150));
		expect(document.body.querySelector(".gui-pr-list-popup") === null).toBe(true);
		expect(host.querySelector(".gui-pr-detail")?.textContent).toContain("Issue 2");
	});

	test("posts a comment, clears the composer, and refreshes the detail", async () => {
		const { rpc, calls } = rpcWithDetails([]);
		await render(rpc);
		await typeComment("A useful note");
		const submit = host.querySelector<HTMLButtonElement>(".gui-pr-comment-submit");
		expect(submit?.disabled).toBe(false);
		await act(async () => submit?.click());
		await flush();
		await flush();
		expect(calls.find(call => call.method === "github.issueComment")?.params).toEqual({
			cwd: "/repo",
			number: 1,
			body: "A useful note",
		});
		expect(host.querySelector<HTMLTextAreaElement>(".gui-pr-comment-composer textarea")?.value).toBe("");
		expect(calls.filter(call => call.method === "github.issueView").length).toBeGreaterThanOrEqual(2);
	});

	test("submits a non-empty comment with Ctrl+Enter", async () => {
		const { rpc, calls } = rpcWithDetails([]);
		await render(rpc);
		await typeComment("Keyboard note");
		const composer = host.querySelector<HTMLTextAreaElement>(".gui-pr-comment-composer textarea")!;
		const propsKey = Object.keys(composer).find(key => key.startsWith("__reactProps$"))!;
		const props = (composer as unknown as Record<string, { onKeyDown(event: unknown): void }>)[propsKey]!;
		let prevented = false;
		await act(async () =>
			props.onKeyDown({
				key: "Enter",
				ctrlKey: true,
				metaKey: false,
				nativeEvent: { isComposing: false },
				preventDefault: () => {
					prevented = true;
				},
			}),
		);
		await flush();
		expect(prevented).toBe(true);
		expect(calls.find(call => call.method === "github.issueComment")?.params).toMatchObject({
			number: 1,
			body: "Keyboard note",
		});
	});

	test("an older detail response cannot replace the latest selection", async () => {
		const first = Promise.withResolvers<{ issue: IssueFixture }>();
		const second = Promise.withResolvers<{ issue: IssueFixture }>();
		const { rpc } = rpcWithDetails([first, second]);
		await render(rpc);
		const rows = host.querySelectorAll<HTMLButtonElement>(".gui-pr-list-row");
		expect(rows.length).toBe(2);
		await act(async () => rows[1]?.click());
		await act(async () => second.resolve({ issue: issue(2) }));
		await flush();
		expect(host.querySelector(".gui-pr-detail")?.textContent).toContain("Issue 2");
		await act(async () => first.resolve({ issue: issue(1) }));
		await flush();
		expect(host.querySelector(".gui-pr-detail")?.textContent).toContain("Issue 2");
		expect(host.querySelector(".gui-pr-detail")?.textContent).not.toContain("Bold body");
	});

	test("a comment finishing on the old item cannot replace the new selection", async () => {
		const second = Promise.withResolvers<{ issue: IssueFixture }>();
		const comment = Promise.withResolvers<{ ok: boolean }>();
		const { rpc } = rpcWithDetails([undefined, second], comment);
		await render(rpc);
		await typeComment("Comment from first");
		await act(async () => host.querySelector<HTMLButtonElement>(".gui-pr-comment-submit")?.click());
		const rows = host.querySelectorAll<HTMLButtonElement>(".gui-pr-list-row");
		await act(async () => rows[1]?.click());
		await act(async () => second.resolve({ issue: issue(2) }));
		await flush();
		expect(host.querySelector(".gui-pr-detail")?.textContent).toContain("Issue 2");
		await act(async () => comment.resolve({ ok: true }));
		await flush();
		await flush();
		expect(host.querySelector(".gui-pr-detail")?.textContent).toContain("Issue 2");
		expect(host.querySelector(".gui-pr-detail")?.textContent).not.toContain("Bold body");
	});

	test("comment drafts stay with their original item", async () => {
		const { rpc } = rpcWithDetails([]);
		await render(rpc);
		await typeComment("Only for issue one");
		const rows = host.querySelectorAll<HTMLButtonElement>(".gui-pr-list-row");
		await act(async () => rows[1]?.click());
		await flush();
		expect(host.querySelector<HTMLTextAreaElement>(".gui-pr-comment-composer textarea")?.value).toBe("");
	});

	test("an older filter response cannot replace the latest list", async () => {
		const first = Promise.withResolvers<{ issues: IssueFixture[] }>();
		const second = Promise.withResolvers<{ issues: IssueFixture[] }>();
		let listIndex = 0;
		const request = (method: string): Promise<unknown> => {
			if (method === "github.issues") {
				const pending = [first, second][listIndex++]!;
				return pending.promise;
			}
			if (method === "github.issueView") return Promise.resolve({ issue: issue(2) });
			return Promise.resolve({});
		};
		await render({ request } as unknown as RpcClient);
		const author = host.querySelector<HTMLInputElement>('input[aria-label="Filter by author"]')!;
		const propsKey = Object.keys(author).find(key => key.startsWith("__reactProps$"))!;
		const props = (author as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
		author.value = "octocat";
		await act(async () => props.onChange({ target: author, currentTarget: author }));
		await act(async () => second.resolve({ issues: [issue(2)] }));
		await flush();
		expect(host.querySelectorAll(".gui-pr-list-row").length).toBe(1);
		expect(host.querySelector(".gui-pr-list-row")?.textContent).toContain("Issue 2");
		await act(async () => first.resolve({ issues: [issue(1)] }));
		await flush();
		expect(host.querySelector(".gui-pr-list-row")?.textContent).toContain("Issue 2");
	});

	test("refreshes a stale list on window focus without refetching fresh data", async () => {
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { rpc, calls } = rpcWithDetails([]);
		await render(rpc);
		expect(calls.filter(call => call.method === "github.issues").length).toBe(1);

		await act(async () => window.dispatchEvent(new Event("focus")));
		expect(calls.filter(call => call.method === "github.issues").length).toBe(1);
		now += 61_000;
		await act(async () => window.dispatchEvent(new Event("focus")));
		await flush();
		expect(calls.filter(call => call.method === "github.issues").length).toBe(2);
	});

	test("long PR branch metadata has a shrinkable wrapper", async () => {
		localStorage.setItem("musepi-gui-prcenter-tab", "prs");
		const pr = {
			...issue(7),
			isDraft: false,
			headRefName: "feature/a-very-long-branch-name-that-must-not-widen-the-list",
			baseRefName: "main",
			statusCheckRollup: [],
			reviewers: [],
			assignees: [],
		};
		const request = (method: string): Promise<unknown> => {
			if (method === "github.prStatus") return Promise.resolve({ pr: null });
			if (method === "github.prs") return Promise.resolve({ prs: [pr] });
			if (method === "github.prView") return Promise.resolve({ pr });
			return Promise.resolve({});
		};
		await render({ request } as unknown as RpcClient);
		expect(host.querySelector(".gui-pr-list-branches")).not.toBeNull();
		expect(host.querySelector(".gui-pr-filter-row .gui-group-label") === null).toBe(true);
		expect(host.querySelector(".gui-pr-list > .gui-group-label") === null).toBe(true);
	});

	test("narrow PR creation keeps the popup and its form open while editing", async () => {
		mockBoardWidth(700);
		localStorage.setItem("musepi-gui-prcenter-tab", "prs");
		const request = (method: string): Promise<unknown> => {
			if (method === "github.prStatus") return Promise.resolve({ pr: null });
			if (method === "github.prs") return Promise.resolve({ prs: [] });
			if (method === "git.status") return Promise.resolve({ branch: "main", ahead: 1 });
			if (method === "git.branches") return Promise.resolve({ branches: ["main"] });
			return Promise.resolve({});
		};
		await render({ request } as unknown as RpcClient);
		await act(async () => host.querySelector<HTMLButtonElement>(".gui-pr-list-toggle")?.click());
		const title = document.body.querySelector<HTMLInputElement>(".gui-pr-list-popup .gui-pr-create input")!;
		await act(async () => title.click());
		await act(async () => Bun.sleep(150));
		expect(document.body.querySelector(".gui-pr-list-popup") !== null).toBe(true);
	});

	test("a transient PR error keeps refresh and state filters available", async () => {
		localStorage.setItem("musepi-gui-prcenter-tab", "prs");
		const request = (method: string): Promise<unknown> => {
			if (method === "github.prStatus" || method === "github.prs") return Promise.resolve({ error: "offline" });
			return Promise.resolve({});
		};
		await render({ request } as unknown as RpcClient);
		expect(host.querySelector(".gui-pr-filter-row") !== null).toBe(true);
		expect(host.querySelector(".gui-pr-filter-row")?.textContent).toContain("Refresh");
		expect(host.textContent).toContain("offline");
	});

	test("opens and quotes current PR review lines without trusting stale or escaping paths", async () => {
		localStorage.setItem("musepi-gui-prcenter-tab", "prs");
		const detail = {
			...issue(7),
			isDraft: false,
			headRefName: "feature/review",
			baseRefName: "main",
			statusCheckRollup: [],
			reviewers: [],
			reviews: [
				{
					author: { login: "reviewer" },
					body: "Looks good overall",
					state: "APPROVED",
					submittedAt: "2026-10-25T00:00:00Z",
				},
			],
			reviewComments: [
				{
					id: 11,
					path: "src/example.ts",
					line: 12,
					originalLine: 12,
					startLine: null,
					originalStartLine: null,
					side: "RIGHT",
					startSide: null,
					diffHunk: "@@ -10,3 +10,3 @@\n+const answer = 42;",
					body: "Explain this constant",
					author: { login: "reviewer" },
					createdAt: "2026-10-25T00:00:00Z",
					inReplyToId: null,
					url: "https://github.com/o/r/pull/7#discussion_r11",
					outdated: false,
				},
				{
					id: 12,
					path: "src/example.ts",
					line: 12,
					originalLine: 12,
					startLine: null,
					originalStartLine: null,
					side: "RIGHT",
					startSide: null,
					diffHunk: "",
					body: "I will add a comment",
					author: { login: "octocat" },
					createdAt: "2026-10-25T00:01:00Z",
					inReplyToId: 11,
					url: "",
					outdated: false,
				},
				{
					id: 13,
					path: "src/old.ts",
					line: null,
					originalLine: 8,
					startLine: null,
					originalStartLine: null,
					side: "RIGHT",
					startSide: null,
					diffHunk: "@@ -8 +8 @@",
					body: "Old position",
					author: { login: "reviewer" },
					createdAt: "2026-10-25T00:02:00Z",
					inReplyToId: null,
					url: "",
					outdated: true,
				},
				{
					id: 14,
					path: "../outside.ts",
					line: 2,
					originalLine: 2,
					startLine: null,
					originalStartLine: null,
					side: "RIGHT",
					startSide: null,
					diffHunk: "",
					body: "Orphaned reply",
					author: { login: "reviewer" },
					createdAt: "2026-10-25T00:03:00Z",
					inReplyToId: 999,
					url: "",
					outdated: false,
				},
			],
		};
		const request = (method: string): Promise<unknown> => {
			if (method === "github.prStatus") return Promise.resolve({ pr: null });
			if (method === "github.prs") return Promise.resolve({ prs: [detail] });
			if (method === "github.prView") return Promise.resolve({ pr: detail });
			return Promise.resolve({});
		};
		await render({ request } as unknown as RpcClient);

		expect(host.querySelector(".gui-pr-reviews")?.textContent).toContain("Looks good overall");
		expect(host.querySelectorAll(".gui-pr-review-thread").length).toBe(3);
		expect(host.querySelector(".gui-pr-review-thread")?.textContent).toContain("I will add a comment");
		expect(host.querySelector(".gui-pr-review-diff")?.textContent).toContain("const answer = 42");
		const openButtons = host.querySelectorAll<HTMLButtonElement>(".gui-pr-review-open");
		expect(openButtons.length).toBe(3);
		expect(openButtons[0]?.disabled).toBe(false);
		expect(openButtons[1]?.disabled).toBe(true);
		expect(openButtons[2]?.disabled).toBe(true);

		let opened: Record<string, unknown> | undefined;
		let quoted: Record<string, unknown> | undefined;
		const onOpen = (event: Event): void => {
			opened = (event as CustomEvent<Record<string, unknown>>).detail;
		};
		const onQuote = (event: Event): void => {
			quoted = (event as CustomEvent<{ displayContext: Record<string, unknown> }>).detail.displayContext;
		};
		window.addEventListener("musepi-open-file", onOpen);
		window.addEventListener("musepi-gui-quote-append", onQuote);
		try {
			await act(async () => openButtons[0]?.click());
			await act(async () => host.querySelector<HTMLButtonElement>(".gui-pr-review-quote")?.click());
		} finally {
			window.removeEventListener("musepi-open-file", onOpen);
			window.removeEventListener("musepi-gui-quote-append", onQuote);
		}
		expect(opened).toEqual({ path: "src/example.ts", line: 12, column: 1, pin: true });
		expect(quoted).toMatchObject({
			kind: "file-quote",
			path: "src/example.ts",
			quote: "@@ -10,3 +10,3 @@\n+const answer = 42;",
			language: "diff",
		});
		expect(quoted?.comment).toContain("PR #7");
		expect(quoted?.comment).toContain("Explain this constant");
	});

	test("submits PR reviews and keeps a rejected change-request draft", async () => {
		localStorage.setItem("musepi-gui-prcenter-tab", "prs");
		const detail = {
			...issue(7),
			isDraft: false,
			headRefName: "feature/review",
			baseRefName: "main",
			statusCheckRollup: [],
			reviewers: [],
			assignees: [],
		};
		const calls: Call[] = [];
		let reviewResult: { ok?: boolean; error?: string } = { ok: true };
		const request = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
			calls.push({ method, params });
			if (method === "github.prStatus") return Promise.resolve({ pr: null });
			if (method === "github.prs") return Promise.resolve({ prs: [detail] });
			if (method === "github.prView") return Promise.resolve({ pr: detail });
			if (method === "github.prReview") return Promise.resolve(reviewResult);
			return Promise.resolve({});
		};
		await render({ request } as unknown as RpcClient);
		const approve = host.querySelector<HTMLButtonElement>(".gui-pr-review-approve")!;
		const requestChanges = host.querySelector<HTMLButtonElement>(".gui-pr-review-request-changes")!;
		expect(approve.disabled).toBe(false);
		expect(requestChanges.disabled).toBe(true);
		await act(async () => approve.click());
		await flush();
		expect(calls.find(call => call.method === "github.prReview")?.params).toEqual({
			cwd: "/repo",
			number: 7,
			event: "approve",
			body: "",
		});

		const composer = host.querySelector<HTMLTextAreaElement>(".gui-pr-review-composer textarea")!;
		const propsKey = Object.keys(composer).find(key => key.startsWith("__reactProps$"))!;
		const props = (composer as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
		composer.value = "Please add regression coverage";
		await act(async () => props.onChange({ target: composer, currentTarget: composer }));
		reviewResult = { error: "review rejected" };
		await act(async () => host.querySelector<HTMLButtonElement>(".gui-pr-review-request-changes")?.click());
		await flush();
		expect(composer.value).toBe("Please add regression coverage");
		expect(host.querySelector(".gui-pr-error")?.textContent).toContain("review rejected");
		expect(calls.filter(call => call.method === "github.prReview").at(-1)?.params).toMatchObject({
			event: "request-changes",
			body: "Please add regression coverage",
		});
	});
});
