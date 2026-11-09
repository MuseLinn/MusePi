import "./happy-dom-shim";
import { beforeEach, describe, expect, test } from "bun:test";
import {
	invalidateGitStatus,
	invalidateGitStatuses,
	onGitStatusChanged,
	readGitStatusCached,
} from "../src/lib/git-status-cache";

function fakeRpc() {
	let calls = 0;
	return {
		calls: () => calls,
		async request<T>(): Promise<T> {
			calls += 1;
			return { branch: "main", staged: [], unstaged: [], untracked: [] } as T;
		},
	};
}

beforeEach(() => {
	invalidateGitStatus();
});

describe("readGitStatusCached", () => {
	test("shares one request inside the TTL and refreshes on force", async () => {
		const rpc = fakeRpc();
		await readGitStatusCached(rpc, "/work/alpha");
		await readGitStatusCached(rpc, "/work/alpha");
		expect(rpc.calls()).toBe(1);
		await readGitStatusCached(rpc, "/work/alpha", { force: true });
		expect(rpc.calls()).toBe(2);
	});

	test("deduplicates concurrent reads of the same root", async () => {
		const rpc = fakeRpc();
		await Promise.all([
			readGitStatusCached(rpc, "/work/shared"),
			readGitStatusCached(rpc, "/work/shared"),
			readGitStatusCached(rpc, "/work/shared"),
		]);
		expect(rpc.calls()).toBe(1);
	});

	test("invalidation notifies listeners with the root scope", () => {
		const seen: Array<string | undefined> = [];
		const off = onGitStatusChanged(cwd => seen.push(cwd));
		invalidateGitStatus("/work/alpha");
		invalidateGitStatus();
		off();
		expect(seen).toEqual(["/work/alpha", undefined]);
	});

	test("a multi-root push invalidates all roots but notifies once", async () => {
		const rpc = fakeRpc();
		await readGitStatusCached(rpc, "/work/alpha");
		await readGitStatusCached(rpc, "/work/shared");
		const seen: Array<string | undefined> = [];
		const off = onGitStatusChanged(cwd => seen.push(cwd));
		invalidateGitStatuses(["/work/alpha", "/work/shared"]);
		off();
		expect(seen).toEqual([undefined]);
		await readGitStatusCached(rpc, "/work/alpha");
		await readGitStatusCached(rpc, "/work/shared");
		expect(rpc.calls()).toBe(4);
	});

	test("invalidate drops one root without touching another", async () => {
		const rpc = fakeRpc();
		await readGitStatusCached(rpc, "/work/alpha");
		await readGitStatusCached(rpc, "/work/shared");
		invalidateGitStatus("/work/alpha");
		await readGitStatusCached(rpc, "/work/alpha");
		await readGitStatusCached(rpc, "/work/shared");
		expect(rpc.calls()).toBe(3);
	});
});
