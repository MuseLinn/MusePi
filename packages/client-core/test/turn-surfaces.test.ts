import { describe, expect, test } from "bun:test";
import { collectTurnFiles, turnFileTotals } from "../src/components/transcript/turn-files";
import { collectTurnSources, sourceHost } from "../src/components/transcript/turn-sources";

/**
 * Turn surfaces derive from the tool results the transcript already holds:
 * browser operations for the sources card, edit/write results for the files
 * card. The card contract is counts and grouping, so these tests pin the
 * branches that decide what a reader is told.
 */

const noResults = () => undefined;

describe("collectTurnSources", () => {
	const operation = (overrides: Record<string, unknown>): Record<string, unknown> => ({
		status: "completed",
		startedAt: 1,
		...overrides,
		id: `op-${String(overrides.id)}`,
	});

	const sourcesOf = (
		results: Record<string, { isError?: boolean; details?: unknown }>,
		blocks: { type: string; id?: string; name?: string }[] = Object.keys(results).map(id => ({
			type: "toolCall",
			id,
			name: "browser",
		})),
	) => collectTurnSources(blocks, id => results[id]);

	test("groups pages into read and passed, counting opens per page", () => {
		const sources = sourcesOf({
			b1: {
				details: {
					url: "https://a.test",
					operations: [
						operation({ id: 1, action: "goto", pageUrl: "https://a.test", pageTitle: "A" }),
						operation({ id: 2, action: "observe", pageUrl: "https://a.test" }),
					],
				},
			},
			b2: {
				details: {
					operations: [
						operation({ id: 3, action: "goto", pageUrl: "https://b.test" }),
						operation({ id: 4, action: "goto", pageUrl: "https://a.test" }),
						operation({ id: 5, action: "click", pageUrl: "https://a.test" }),
					],
				},
			},
		});
		expect(sources.pages).toEqual([
			{ url: "https://a.test", title: "A", opens: 2, read: true },
			{ url: "https://b.test", title: "", opens: 1, read: false },
		]);
		expect(sources.readCount).toBe(1);
		expect(sources.passedCount).toBe(1);
	});

	test("a page observed without navigating still counts as one open", () => {
		const sources = sourcesOf({
			b1: {
				details: {
					url: "https://fallback.test",
					operations: [operation({ id: 1, action: "observe" })],
				},
			},
		});
		expect(sources.pages).toEqual([{ url: "https://fallback.test", title: "", opens: 1, read: true }]);
	});

	test("structured read and open actions classify real pages", () => {
		const sources = sourcesOf({
			b1: {
				details: {
					action: "open",
					url: "https://passed.test",
					operations: [],
				},
			},
			b2: {
				details: {
					action: "read",
					url: "https://read.test",
					pageText: { url: "https://read.test", title: "Structured page" },
					operations: [operation({ id: 1, action: "evaluate", pageUrl: "https://read.test" })],
				},
			},
		});
		expect(sources.pages).toEqual([
			{ url: "https://passed.test", title: "", opens: 1, read: false },
			{ url: "https://read.test", title: "Structured page", opens: 1, read: true },
		]);
		expect(sources.readCount).toBe(1);
		expect(sources.passedCount).toBe(1);
	});

	test("repeated opens plus a structured read stay one read page", () => {
		const sources = sourcesOf({
			b1: { details: { action: "open", url: "https://same.test", operations: [] } },
			b2: { details: { action: "open", url: "https://same.test", operations: [] } },
			b3: {
				details: {
					action: "read",
					pageText: { url: "https://same.test", title: "Same page" },
					operations: [],
				},
			},
		});
		expect(sources.pages).toEqual([{ url: "https://same.test", title: "Same page", opens: 2, read: true }]);
		expect(sources.readCount).toBe(1);
		expect(sources.passedCount).toBe(0);
	});

	test("screenshots, clicks and status do not invent visited pages", () => {
		const sources = sourcesOf({
			b1: {
				details: {
					action: "screenshot",
					url: "https://shot.test",
					operations: [operation({ id: 1, action: "screenshot", pageUrl: "https://shot.test" })],
				},
			},
			b2: {
				details: {
					action: "run",
					url: "https://click.test",
					operations: [operation({ id: 2, action: "click", pageUrl: "https://click.test" })],
				},
			},
			b3: { details: { action: "status", status: { available: true }, operations: [] } },
		});
		expect(sources).toEqual({ pages: [], readCount: 0, passedCount: 0 });
	});

	test("failed operations, failed calls and non-browser tools contribute nothing", () => {
		const sources = sourcesOf(
			{
				b1: {
					details: {
						operations: [
							operation({ id: 1, action: "goto", pageUrl: "https://c.test", status: "failed" }),
							operation({ id: 2, action: "goto", pageUrl: "https://running.test", status: "running" }),
						],
					},
				},
				b2: {
					isError: true,
					details: { operations: [operation({ id: 3, action: "goto", pageUrl: "https://err.test" })] },
				},
				b3: {
					details: { operations: [operation({ id: 4, action: "goto", pageUrl: "https://ok.test" })] },
				},
			},
			[
				{ type: "toolCall", id: "b1", name: "browser" },
				{ type: "toolCall", id: "b2", name: "browser" },
				{ type: "toolCall", id: "b3", name: "browser" },
				{ type: "toolCall", id: "b4", name: "web_search" },
			],
		);
		expect(sources.pages).toEqual([{ url: "https://ok.test", title: "", opens: 1, read: false }]);
	});

	test("a turn without browser calls has no pages", () => {
		expect(collectTurnSources([], noResults)).toEqual({ pages: [], readCount: 0, passedCount: 0 });
	});
});

describe("sourceHost", () => {
	test("keeps the hostname, falls back to the raw value", () => {
		expect(sourceHost("https://example.com/a/b?q=1")).toBe("example.com");
		expect(sourceHost("not a url")).toBe("not a url");
	});
});

describe("collectTurnFiles", () => {
	const blocks = [
		{ type: "toolCall", id: "e1", name: "edit", arguments: { content: "[src/a.ts#a1b2]\n- old\n+ new\n" } },
		{ type: "toolCall", id: "e2", name: "write", arguments: { path: "docs/new.md" } },
		{ type: "toolCall", id: "e3", name: "edit", arguments: { content: "[src/b.ts#b2c3]\n" } },
		{ type: "toolCall", id: "e4", name: "write", arguments: { path: "src/broken.ts" } },
	];

	const results: Record<string, { isError?: boolean; details?: unknown }> = {
		e1: { details: { path: "src/a.ts", diff: "+one\n+two\n-old\n" } },
		e2: {},
		e3: {
			details: {
				perFileResults: [
					{ path: "src/b.ts", diff: "+three\n" },
					{ path: "src/c.ts", diff: "-x\n", isError: true },
				],
			},
		},
		e4: { isError: true },
	};

	test("lists the turn's files with per-file line counts", () => {
		const files = collectTurnFiles(blocks, id => results[id]);
		expect(files).toEqual([
			{ path: "src/a.ts", added: 2, removed: 1, hasDiff: true },
			{ path: "docs/new.md", added: 0, removed: 0, hasDiff: false },
			{ path: "src/b.ts", added: 1, removed: 0, hasDiff: true },
		]);
		expect(turnFileTotals(files)).toEqual({ added: 3, removed: 1 });
	});

	test("sums repeated edits of the same path and keeps first-seen order", () => {
		const twice = [
			{ type: "toolCall", id: "e1", name: "edit", arguments: { content: "[src/a.ts#a1b2]\n" } },
			{ type: "toolCall", id: "e5", name: "edit", arguments: { content: "[src/z.ts#c3d4]\n" } },
			{ type: "toolCall", id: "e6", name: "edit", arguments: { content: "[src/a.ts#d4e5]\n" } },
		];
		const cumulative: Record<string, { details?: unknown }> = {
			e1: { details: { path: "src/a.ts", diff: "+one\n" } },
			e5: { details: { path: "src/z.ts", diff: "+z\n" } },
			e6: { details: { path: "src/a.ts", diff: "+two\n-three\n" } },
		};
		const files = collectTurnFiles(twice, id => cumulative[id]);
		expect(files.map(file => file.path)).toEqual(["src/a.ts", "src/z.ts"]);
		expect(files[0]).toEqual({ path: "src/a.ts", added: 2, removed: 1, hasDiff: true });
	});

	test("a write without diff details reports no diff instead of zero lines", () => {
		const files = collectTurnFiles(
			[{ type: "toolCall", id: "w1", name: "write", arguments: { path: "notes.md" } }],
			id => results[id] ?? { isError: false },
		);
		expect(files).toEqual([{ path: "notes.md", added: 0, removed: 0, hasDiff: false }]);
	});

	test("a turn without write-class calls has no files", () => {
		expect(collectTurnFiles([], noResults)).toEqual([]);
	});
});
