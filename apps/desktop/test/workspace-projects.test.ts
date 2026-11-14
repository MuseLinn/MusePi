import { describe, expect, it } from "bun:test";
import {
	addProjectDirectory,
	directoriesEqual,
	LEGACY_DISMISSED_KEY,
	LEGACY_MIGRATION_KEY,
	LEGACY_PROJECTS_KEY,
	migrateLegacyProjects,
	mirrorProjects,
	removeProjectDirectory,
	type WorkspaceStorage,
} from "../src/lib/workspace-projects";

function storageOf(initial: Record<string, string> = {}): WorkspaceStorage {
	const entries = new Map(Object.entries(initial));
	return {
		getItem: key => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
		removeItem: key => void entries.delete(key),
	};
}

interface Call {
	method: string;
	params: unknown;
}

function rpcStub(options: { missing?: string[]; failCreateFor?: string[] } = {}): {
	calls: Call[];
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
} {
	const calls: Call[] = [];
	return {
		calls,
		async request<T>(method: string, params?: unknown): Promise<T> {
			calls.push({ method, params });
			if (method === "fs.stat") {
				const path = (params as { path: string }).path;
				return { exists: !(options.missing ?? []).includes(path), isDirectory: true } as T;
			}
			if (method === "workspace.create") {
				const root = (params as { root: string }).root;
				if ((options.failCreateFor ?? []).includes(root)) throw new Error("daemon unavailable");
				return { workspace: { id: `id-${root}`, root }, duplicates: [] } as T;
			}
			if (method === "workspace.update") {
				return { workspace: { id: "w1", root: "/work/a" }, duplicates: [] } as T;
			}
			throw new Error(`unexpected RPC: ${method}`);
		},
	};
}

describe("workspace project registry helpers", () => {
	it("imports the legacy list once, skipping dismissed and missing folders", async () => {
		const storage = storageOf({
			[LEGACY_PROJECTS_KEY]: JSON.stringify(["/work/a", "/work/gone", "/work/removed"]),
			[LEGACY_DISMISSED_KEY]: JSON.stringify(["/work/removed"]),
		});
		const rpc = rpcStub({ missing: ["/work/gone"] });

		const result = await migrateLegacyProjects(rpc, storage);

		expect(result).toEqual({ imported: ["/work/a"], skipped: ["/work/gone"], failed: [], migrated: true });
		expect(rpc.calls.filter(call => call.method === "workspace.create")).toEqual([
			{ method: "workspace.create", params: { root: "/work/a" } },
		]);
		expect(storage.getItem(LEGACY_PROJECTS_KEY)).toBeNull();
		expect(storage.getItem(LEGACY_DISMISSED_KEY)).toBeNull();
		expect(storage.getItem(LEGACY_MIGRATION_KEY)).toBe("1");

		// A second mount must not import anything again.
		const again = await migrateLegacyProjects(rpc, storage);
		expect(again.imported).toEqual([]);
		expect(rpc.calls.filter(call => call.method === "workspace.create")).toHaveLength(1);
	});

	it("keeps the legacy list when a project fails, so the next mount retries", async () => {
		const storage = storageOf({ [LEGACY_PROJECTS_KEY]: JSON.stringify(["/work/a", "/work/b"]) });
		const rpc = rpcStub({ failCreateFor: ["/work/b"] });

		const result = await migrateLegacyProjects(rpc, storage);

		expect(result.migrated).toBe(false);
		expect(result.imported).toEqual(["/work/a"]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]).toContain("/work/b");
		expect(storage.getItem(LEGACY_PROJECTS_KEY)).toContain("/work/b");
		expect(storage.getItem(LEGACY_MIGRATION_KEY)).toBeNull();
	});

	it("mirrors registry roots for surfaces that still read the legacy key", () => {
		const storage = storageOf({ [LEGACY_MIGRATION_KEY]: "1" });
		mirrorProjects(storage, [
			{
				id: "1",
				root: "/work/a",
				name: "a",
				kind: "managed",
				additionalDirs: [],
				createdAt: 0,
				lastOpenedAt: 0,
			},
		]);
		expect(JSON.parse(storage.getItem(LEGACY_PROJECTS_KEY) ?? "[]")).toEqual(["/work/a"]);

		// Before migration the legacy list is the only copy: never overwrite it.
		const fresh = storageOf({ [LEGACY_PROJECTS_KEY]: JSON.stringify(["/legacy"]) });
		mirrorProjects(fresh, []);
		expect(JSON.parse(fresh.getItem(LEGACY_PROJECTS_KEY) ?? "[]")).toEqual(["/legacy"]);
	});

	it("adds a directory as part of the full set so the daemon reports duplicates", async () => {
		const rpc = rpcStub();
		await addProjectDirectory(rpc, { id: "w1", additionalDirs: ["/work/docs"] }, "/work/docs");
		expect(rpc.calls).toEqual([
			{
				method: "workspace.update",
				params: { id: "w1", additionalDirs: ["/work/docs", "/work/docs"] },
			},
		]);
	});

	it("removes a directory regardless of separator or drive-letter casing", async () => {
		const rpc = rpcStub();
		await removeProjectDirectory(
			rpc,
			{ id: "w2", additionalDirs: ["D:/Work/Docs", "D:\\Work\\Src"] },
			"d:/work/docs/",
		);
		expect(rpc.calls).toEqual([
			{
				method: "workspace.update",
				params: { id: "w2", additionalDirs: ["D:\\Work\\Src"] },
			},
		]);
	});

	it("treats trailing slashes as the same directory but keeps POSIX case", () => {
		expect(directoriesEqual("/work/a/", "/work/a")).toBe(true);
		expect(directoriesEqual("D:\\Work\\A", "d:/work/a/")).toBe(true);
		expect(directoriesEqual("/work/A", "/work/a")).toBe(false);
	});
});
