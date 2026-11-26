import { describe, expect, test } from "bun:test";
import {
	type AtCandidate,
	type AtCompletionEntry,
	atCandidateGroup,
	loadAtCompletionEntries,
	rankAtCandidates,
	rankAtCompletionEntries,
} from "../src/lib/at-completion";

interface TreeEntry {
	name: string;
	path: string;
	isDir: boolean;
}

function rpcFor(entriesByRoot: Record<string, TreeEntry[]>, ignoredByRoot: Record<string, TreeEntry[]> = {}) {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	return {
		calls,
		async request<T>(method: string, params?: unknown): Promise<T> {
			calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
			if (method === "session.directories.list") {
				return {
					directories: [
						{ path: "/work/alpha", primary: true, exists: true },
						{ path: "/work/shared", primary: false, exists: true },
					],
				} as T;
			}
			if (method === "workspace.tree") {
				const p = (params ?? {}) as { cwd?: string; gitignore?: boolean };
				const cwd = p.cwd ?? "";
				const entries =
					p.gitignore === false
						? [...(entriesByRoot[cwd] ?? []), ...(ignoredByRoot[cwd] ?? [])]
						: (entriesByRoot[cwd] ?? []);
				return {
					entries: entries.map(entry => ({ ...entry, depth: 1, size: 0, mtime: 0 })),
				} as T;
			}
			throw new Error(`unexpected RPC: ${method}`);
		},
	};
}

describe("loadAtCompletionEntries", () => {
	test("keeps primary paths relative and makes additional-root paths absolute", async () => {
		const entries = await loadAtCompletionEntries({
			rpc: rpcFor({
				"/work/alpha": [{ name: "main.ts", path: "src/main.ts", isDir: false }],
				"/work/shared": [{ name: "doc.md", path: "docs/doc.md", isDir: false }],
			}),
			cwd: "/work/alpha",
			sessionId: "s1",
		});

		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({ path: "src/main.ts", rootLabel: undefined });
		expect(entries[0]?.insertPath).toBeUndefined();
		expect(entries[1]).toMatchObject({
			path: "docs/doc.md",
			insertPath: "/work/shared/docs/doc.md",
			rootLabel: "shared",
		});
	});

	test("deduplicates the same file surfaced through two roots", async () => {
		const entries = await loadAtCompletionEntries({
			rpc: rpcFor({
				"/work/alpha": [{ name: "same.ts", path: "src/same.ts", isDir: false }],
				"/work/shared": [{ name: "same.ts", path: "src/same.ts", isDir: false }],
			}),
			cwd: "/work/alpha",
			sessionId: "s1",
		});
		// Different roots resolve to different absolute insert paths, so both
		// remain selectable; only an identical insert path is dropped.
		expect(entries.map(entry => entry.insertPath ?? entry.path)).toEqual(["src/same.ts", "/work/shared/src/same.ts"]);
	});

	test("includes gitignore-only paths after the visible scan and marks them", async () => {
		const rpc = rpcFor(
			{ "/work/alpha": [{ name: "main.ts", path: "src/main.ts", isDir: false }] },
			{ "/work/alpha": [{ name: "bundle.js", path: "dist/bundle.js", isDir: false }] },
		);
		const entries = await loadAtCompletionEntries({ rpc, cwd: "/work/alpha" });

		expect(entries.map(entry => entry.path)).toEqual(["src/main.ts", "dist/bundle.js"]);
		expect(entries[1]).toMatchObject({ path: "dist/bundle.js", ignored: true });
		const scans = rpc.calls.filter(call => call.method === "workspace.tree");
		expect(scans.map(call => call.params.gitignore)).toEqual([true, false]);
	});
});

describe("rankAtCompletionEntries", () => {
	const row = (path: string, extra: Partial<AtCompletionEntry> = {}): AtCompletionEntry => {
		const name = path.split("/").at(-1) ?? path;
		return { name, path, isDir: false, depth: 1, ...extra };
	};

	test("orders exact, prefix, path-prefix and substring matches by quality", () => {
		const ranked = rankAtCompletionEntries(
			[row("src/domain.ts"), row("docs/main-guide.md"), row("main"), row("main.ts"), row("main/index.ts")],
			"main",
		);
		expect(ranked.map(entry => entry.path)).toEqual([
			"main",
			"docs/main-guide.md",
			"main.ts",
			"main/index.ts",
			"src/domain.ts",
		]);
	});

	test("keeps non-ignored rows ahead of ignored ones at equal quality", () => {
		const ranked = rankAtCompletionEntries([row("dist/main.ts", { ignored: true }), row("src/main.ts")], "main");
		expect(ranked.map(entry => entry.path)).toEqual(["src/main.ts", "dist/main.ts"]);
	});

	test("keeps files ahead of directories at equal quality", () => {
		const ranked = rankAtCompletionEntries([row("main.ts", { isDir: true }), row("main.ts")], "main");
		expect(ranked[0]?.isDir).toBe(false);
		expect(ranked[1]?.isDir).toBe(true);
	});
});

describe("rankAtCandidates", () => {
	const file = (name: string, path: string, extra: Record<string, unknown> = {}): AtCandidate => ({
		kind: "file",
		name,
		path,
		isDir: false,
		depth: 1,
		...extra,
	});
	const session = (id: string, name: string, updatedAt: string, cwd = "/proj"): AtCandidate => ({
		kind: "session",
		id,
		name,
		cwd,
		updatedAt,
	});

	test("sessions lead the list so they are not buried under tree entries", () => {
		const ranked = rankAtCandidates(
			[file("a.ts", "src/a.ts"), session("s1", "发布准备", "2026-11-20T00:00:00.000Z")],
			"",
		);
		expect(ranked.map(c => c.kind)).toEqual(["session", "file"]);
	});

	test("each group ranks its own match quality before recency", () => {
		const ranked = rankAtCandidates(
			[
				session("s-old", "其它会话", "2026-11-25T00:00:00.000Z"),
				session("s-new", "发布准备", "2026-11-01T00:00:00.000Z"),
			],
			"发布",
		);
		expect(ranked[0]).toMatchObject({ kind: "session", id: "s-new" });
	});

	test("session rows match on id and directory too", () => {
		const byId = rankAtCandidates([session("abc123", "标题", "2026-11-20T00:00:00.000Z")], "abc1");
		expect(byId).toHaveLength(1);
		const byDir = rankAtCandidates([session("s", "标题", "2026-11-20T00:00:00.000Z", "/work/api")], "work/api");
		expect(byDir).toHaveLength(1);
	});

	test("a query that matches nothing returns nothing", () => {
		expect(rankAtCandidates([file("a.ts", "src/a.ts")], "zzz")).toEqual([]);
	});

	test("file ranking keeps ignored files last, files before folders", () => {
		const ranked = rankAtCandidates(
			[file("x", "a/x", { ignored: true }), file("y", "a/y", { isDir: true }), file("z", "a/z")],
			"",
		);
		expect(ranked.map(c => c.kind === "file" && c.path)).toEqual(["a/z", "a/y", "a/x"]);
	});

	test("grouping is exposed for the heading rows", () => {
		expect(atCandidateGroup(file("a", "a"))).toBe("file");
		expect(atCandidateGroup(session("s", "t", "2026-11-20T00:00:00.000Z"))).toBe("session");
	});
});
