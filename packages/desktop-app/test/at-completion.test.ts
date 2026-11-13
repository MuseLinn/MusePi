import { describe, expect, test } from "bun:test";
import { type AtCompletionEntry, loadAtCompletionEntries, rankAtCompletionEntries } from "../src/lib/at-completion";

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
