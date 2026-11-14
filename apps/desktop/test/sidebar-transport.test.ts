/**
 * Sidebar transport bridge contract.
 *
 * Stubbed transport, real aborts — no daemon. The point is the chokepoint every
 * sidebar call now runs through, so what gets pinned is its behaviour at that
 * seam: what it forwards, how a rejection surfaces, and how abort is delivered.
 * None of that depends on a live socket, and all of it would be wrong in a way
 * the UI could not survive if the bridge were moved.
 */
import { describe, expect, test } from "bun:test";
import { callSidebar, type RpcTransport, SidebarApiError } from "../src/lib/sidebar-transport";

/** A transport whose one request resolves/rejects with a chosen outcome. */
function transport(behavior: { result?: unknown; reject?: Error }): {
	rpc: RpcTransport;
	calls: { method: string; params: unknown }[];
} {
	const calls: { method: string; params: unknown }[] = [];
	return {
		calls,
		rpc: {
			request<T>(method: string, params?: unknown): Promise<T> {
				calls.push({ method, params });
				if (behavior.reject) return Promise.reject(behavior.reject);
				return Promise.resolve(behavior.result as T);
			},
		},
	};
}

describe("callSidebar", () => {
	test("forwards an un-adapted method by identity, passing the payload through", async () => {
		// Most read routes already take {cwd, path} in the same shape, so they
		// reach the daemon untouched — a method with no adapter must NOT be
		// silently dropped or rewritten.
		const { rpc, calls } = transport({ result: { entries: [] } });
		const value = await callSidebar<{ entries: unknown[] }>(rpc, "git.status", { cwd: "/w", path: "src" });
		expect(value.entries).toEqual([]);
		expect(calls).toEqual([{ method: "git.status", params: { cwd: "/w", path: "src" } }]);
	});

	test("a JSON-RPC rejection surfaces as a host-coded SidebarApiError", async () => {
		// The daemon answers "Unknown method" / a route-level throw via the RPC
		// error envelope; the component's existing `catch (e)` must see the
		// sidebar's error type, not a raw Error, and read a code it can branch on.
		const { rpc } = transport({ reject: new Error("Unknown method") });
		const err = await callSidebar(rpc, "nope.missing", {}).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SidebarApiError);
		expect((err as SidebarApiError).code).toBe("host");
		expect((err as SidebarApiError).message).toBe("Unknown method");
	});

	test("resolves a route's {error} field as ordinary data, not a failure", async () => {
		// archive.status legitimately returns {error: "..."} when a build failed;
		// turning every resolved {error} into a throw would make the poller unable
		// to read the failure it is meant to display. The transport must NOT judge
		// a successful RPC result's shape.
		const { rpc } = transport({ result: { state: "error", error: "disk full" } });
		const value = await callSidebar<{ state: string }>(rpc, "archive.status", { id: "x" });
		expect(value.state).toBe("error");
	});

	test("a pre-aborted signal rejects without ever hitting the transport", async () => {
		// The sidebar's own fetch aborted before send produced no request; matching
		// that avoids firing a daemon call the caller already abandoned.
		const { rpc, calls } = transport({ result: {} });
		const controller = new AbortController();
		controller.abort();
		const err = await callSidebar(rpc, "fs.read", {}, controller.signal).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SidebarApiError);
		expect((err as SidebarApiError).code).toBe("network");
		expect(calls.length).toBe(0);
	});

	test("an abort during the request releases the caller while the RPC is still open", async () => {
		// RpcClient cannot cancel an in-flight frame, so abort races a still-
		// pending request. The caller must be freed now, not when the request
		// eventually settles — and the late resolution must not throw an
		// unhandled rejection into the process.
		const controller = new AbortController();
		let resolve!: (v: unknown) => void;
		const pending = new Promise<unknown>(r => {
			resolve = r;
		});
		const rpc: RpcTransport = { request: () => pending as never };
		const call = callSidebar(rpc, "fs.read", {}, controller.signal);
		controller.abort();
		const err = await call.then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as SidebarApiError).code).toBe("network");
		// Resolve late; the caller already rejected, this must not resurface.
		resolve({ late: true });
		await pending;
	});

	test("an aborted signal after a real rejection keeps the host error, not a phantom abort", async () => {
		// If the request genuinely failed AND was aborted, the component cares
		// which happened first; Promise.race must not mask a real failure that
		// settled before the abort fired.
		const controller = new AbortController();
		const rpc: RpcTransport = { request: () => Promise.reject(new Error("boom")) };
		const err = await callSidebar(rpc, "fs.read", {}, controller.signal).then(
			() => null,
			(e: unknown) => e,
		);
		expect((err as SidebarApiError).code).toBe("host");
	});
});

describe("callSidebar git.branch adaptation", () => {
	test("renames the call to git.branches and lifts the result into the sidebar's GitBranch shape", async () => {
		// The sidebar consumes
		// `{all, current, branches}` (GitView derives localBranches from .all;
		// the selector reads branchInfo[name].ahead through optional chaining),
		// while the host answers `{current, branches: string[]}` — names only.
		// If regressed to a bare identity forward, the component would read
		// `all` off a host result that only has `branches` and render an
		// empty selector on a repo with plenty of branches.
		const { rpc, calls } = transport({
			result: { current: "main", branches: ["main", "feature/one", "fix-2"] },
		});
		const value = await callSidebar<{ all: string[]; current: string; branches: Record<string, unknown> }>(
			rpc,
			"git.branch",
			{ cwd: "/w" },
		);
		expect(calls).toEqual([{ method: "git.branches", params: { cwd: "/w" } }]);
		expect(value.all).toEqual(["main", "feature/one", "fix-2"]);
		expect(value.current).toBe("main");
		// Detail entries exist per branch with the current flag computed; the
		// fields the host cannot answer (commit, tracking, ahead/behind) stay
		// absent — consumers tolerate that, fabricating zeros would not.
		expect(value.branches.main).toEqual({ current: true, name: "main" });
		expect(value.branches["feature/one"]).toEqual({ current: false, name: "feature/one" });
		expect(value.branches["fix-2"]).toEqual({ current: false, name: "fix-2" });
	});

	test("a detached HEAD (host current: null) maps to the empty current the sidebar treats as no-branch", async () => {
		// The sidebar's GitBranch.current is a plain string; the host uses null
		// for detached HEAD. The adapter must not leak null through — a null
		// would read as a branch literally named "null" in display code.
		const { rpc } = transport({ result: { current: null, branches: ["main"] } });
		const value = await callSidebar<{ current: string; branches: Record<string, unknown> }>(rpc, "git.branch", {});
		expect(value.current).toBe("");
		expect(value.branches.main).toEqual({ current: false, name: "main" });
	});

	test("an un-adapted git method still forwards by identity", async () => {
		// The adapter is per-method, not a git.* wildcard: git.status returns
		// the same shape on both ends of the bridge and must not be routed
		// through the branch adapter.
		const { rpc, calls } = transport({ result: { entries: [] } });
		await callSidebar(rpc, "git.status", { cwd: "/w" });
		expect(calls).toEqual([{ method: "git.status", params: { cwd: "/w" } }]);
	});
});

describe("callSidebar git.worktrees adaptation", () => {
	test("same-named route unwraps the host {worktrees} envelope into the bare list", async () => {
		// The sidebar's HTTP client json()ed the body straight into
		// GitWorktreeInfo[]; the host wraps the list in {worktrees}. A bare
		// identity forward would hand the component an object where it reads
		// .length and .map, breaking the worktree switcher on every repo.
		const { rpc, calls } = transport({
			result: {
				worktrees: [
					{ head: "abc1234", name: "repo", branch: "main", path: "/repo", prunable: false },
					{ head: "def5678", name: "wt", branch: "feature", path: "/wt", prunable: false },
				],
			},
		});
		const value = await callSidebar<{ length: number; 0: { branch: string } }>(rpc, "git.worktrees", { cwd: "/w" });
		expect(calls).toEqual([{ method: "git.worktrees", params: { cwd: "/w" } }]);
		expect(value.length).toBe(2);
		expect(value[0].branch).toBe("main");
	});

	test("a host error result (not a git repo) unwraps to an empty list, not a throw", async () => {
		// The daemon answers {error: "..."} for a non-repo cwd. The sidebar's
		// old client THREW on the HTTP error and callers caught it; the
		// closest faithful behavior here is an empty list — the switcher
		// renders nothing, matching a repo with no linked worktrees.
		const { rpc } = transport({ result: { error: "not a git repository" } });
		const value = await callSidebar<unknown[]>(rpc, "git.worktrees", { cwd: "/w" });
		expect(value).toEqual([]);
	});
});

describe("callSidebar git.log adaptation", () => {
	test("same-named route reshapes host commits into the sidebar's {all, latest, total}", async () => {
		// The sidebar zod-parses {all:[{hash,date,message,refs,body,
		// author_name,author_email,filesChanged,insertions,deletions,
		// parents}],latest,total}; the host answers {commits:[{hash,
		// shortHash,author,timestamp,refs:[{kind,name}],parents,subject}],
		// hasMore}. A bare identity forward would leave every entry missing
		// the fields the history list renders (message, date, author_name).
		const { rpc, calls } = transport({
			result: {
				commits: [
					{
						hash: "a1b2c3",
						shortHash: "a1b2c3d",
						author: "Dev",
						timestamp: 1_700_000_000_000,
						refs: [
							{ kind: "head", name: "main" },
							{ kind: "tag", name: "v1" },
						],
						parents: ["p1"],
						subject: "feat: the thing",
					},
					{
						hash: "d4e5f6",
						shortHash: "d4e5f6a",
						author: "X",
						timestamp: 0,
						refs: [],
						parents: [],
						subject: "fix: other",
					},
				],
				hasMore: true,
			},
		});
		const value = await callSidebar<{ all: unknown[]; latest: unknown; total: number }>(rpc, "git.log", {
			cwd: "/w",
		});
		expect(calls).toEqual([{ method: "git.log", params: { cwd: "/w" } }]);
		expect(value.all).toHaveLength(2);
		const first = value.all[0] as Record<string, unknown>;
		expect(first.hash).toBe("a1b2c3");
		expect(first.message).toBe("feat: the thing");
		expect(first.author_name).toBe("Dev");
		expect(first.refs).toBe("HEAD -> main, v1");
		expect((first.parents as string[]).join()).toBe("p1");
		// Count fields the host doesn't answer are filled (zod requires them),
		// never undefined.
		expect(first.filesChanged).toBe(0);
		expect(first.body).toBe("");
		expect(value.latest).toBe(value.all[0]);
		expect(value.total).toBe(3); // 2 + hasMore
	});

	test("an empty log yields null latest", async () => {
		const { rpc } = transport({ result: { commits: [], hasMore: false } });
		const value = await callSidebar<{ all: unknown[]; latest: unknown; total: number }>(rpc, "git.log", {});
		expect(value.all).toEqual([]);
		expect(value.latest).toBeNull();
		expect(value.total).toBe(0);
	});
});

describe("callSidebar commit.files adaptation", () => {
	const PATCH = [
		"diff --git a/src/a.ts b/src/a.ts",
		"index 111..222 100644",
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1,2 +1,3 @@",
		"-old line",
		"+new line",
		"+another new",
		" context",
		"diff --git a/img.png b/img.png",
		"new file mode 100644",
		"GIT binary patch",
		"literal 10",
	].join("\n");

	test("parses the host's unified patch into the sidebar's per-file entries with counts", async () => {
		// The sidebar fetches a commit's file list as {files:[{path,
		// changeType, insertions, deletions, isBinary}]}; the host ships the
		// whole patch inside git.show. A bare forward would give the list a
		// `diff` string instead of `files` and render nothing.
		const { rpc, calls } = transport({ result: { revision: "a1b2", diff: PATCH } });
		const value = await callSidebar<{ files: Array<Record<string, unknown>> }>(rpc, "commit.files", { hash: "a1b2" });
		expect(calls).toEqual([{ method: "git.show", params: { hash: "a1b2", maxLines: 1 } }]);
		expect(value.files).toHaveLength(2);
		const [tsFile, png] = value.files;
		expect(tsFile.path).toBe("src/a.ts");
		expect(tsFile.changeType).toBe("M");
		expect(tsFile.insertions).toBe(2);
		expect(tsFile.deletions).toBe(1);
		expect(tsFile.isBinary).toBe(false);
		expect(png.path).toBe("img.png");
		expect(png.changeType).toBe("A");
		expect(png.isBinary).toBe(true);
	});

	test("a rename surfaces previousPath and the R change type", async () => {
		const renamePatch = [
			"diff --git a/old.ts b/new.ts",
			"similarity index 90%",
			"rename from old.ts",
			"rename to new.ts",
			"--- a/old.ts",
			"+++ b/new.ts",
			"+added",
		].join("\n");
		const { rpc } = transport({ result: { revision: "r", diff: renamePatch } });
		const value = await callSidebar<{ files: Array<Record<string, unknown>> }>(rpc, "commit.files", { hash: "r" });
		expect(value.files[0].path).toBe("new.ts");
		expect(value.files[0].previousPath).toBe("old.ts");
		expect(value.files[0].changeType).toBe("R");
	});
});

describe("callSidebar commit.fileDiff adaptation", () => {
	const PATCH = [
		"diff --git a/a.ts b/a.ts",
		"--- a/a.ts",
		"+++ b/a.ts",
		"@@ -1,3 +1,3 @@",
		"-removed",
		"kept",
		"+added",
		"diff --git a/other.ts b/other.ts",
		"--- a/other.ts",
		"+++ b/other.ts",
		"+unrelated",
	].join("\n");

	test("extracts the requested file's section and splits it into pre/post images", async () => {
		// The sidebar wants {original, modified, isBinary} for ONE file and
		// renders its own diff; the host ships every file's patch. The hunk
		// split must keep context lines in BOTH images and stop at the next
		// file's header — leaking other.ts's lines would corrupt the view.
		const { rpc } = transport({ result: { revision: "h", diff: PATCH } });
		const value = await callSidebar<{ original: string; modified: string; isBinary: boolean }>(
			rpc,
			"commit.fileDiff",
			{ hash: "h", path: "a.ts" },
		);
		expect(value.isBinary).toBe(false);
		expect(value.original.split("\n")).toEqual(["removed", "kept"]);
		expect(value.modified.split("\n")).toEqual(["kept", "added"]);
	});

	test("a file absent from the commit yields empty images, not a throw", async () => {
		const { rpc } = transport({ result: { revision: "h", diff: PATCH } });
		const value = await callSidebar<{ original: string; isBinary: boolean }>(rpc, "commit.fileDiff", {
			hash: "h",
			path: "missing.ts",
		});
		expect(value.original).toBe("");
		expect(value.isBinary).toBe(false);
	});

	test("a binary section reports isBinary with empty images", async () => {
		const binPatch = ["diff --git a/img b/img", "GIT binary patch", "literal 5"].join("\n");
		const { rpc } = transport({ result: { revision: "h", diff: binPatch } });
		const value = await callSidebar<{ original: string; modified: string; isBinary: boolean }>(
			rpc,
			"commit.fileDiff",
			{ hash: "h", path: "img" },
		);
		expect(value.isBinary).toBe(true);
		expect(value.original).toBe("");
		expect(value.modified).toBe("");
	});
});
