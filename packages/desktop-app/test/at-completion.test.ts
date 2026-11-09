import { describe, expect, test } from "bun:test";
import { loadAtCompletionEntries } from "../src/lib/at-completion";

function rpcFor(entriesByRoot: Record<string, Array<{ name: string; path: string; isDir: boolean }>>) {
	return {
		async request<T>(method: string, params?: unknown): Promise<T> {
			if (method === "session.directories.list") {
				return {
					directories: [
						{ path: "/work/alpha", primary: true, exists: true },
						{ path: "/work/shared", primary: false, exists: true },
					],
				} as T;
			}
			if (method === "workspace.tree") {
				const cwd = (params as { cwd?: string } | undefined)?.cwd ?? "";
				return {
					entries: (entriesByRoot[cwd] ?? []).map(entry => ({ ...entry, depth: 1, size: 0, mtime: 0 })),
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
});
