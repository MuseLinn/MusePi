import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_WORKSPACE_DIRECTORIES,
	resolveWorkspaceDirectories,
	WorkspaceDirectoryError,
	WorkspaceRegistry,
	WorkspaceService,
	type WorkspaceSessionDirectories,
} from "../../src/daemon/services/workspace-registry";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "musepi-workspace-registry-"));
}

function registryAt(root: string, now?: () => number): WorkspaceRegistry {
	return new WorkspaceRegistry({ filePath: join(root, "projects.json"), now });
}

function makeDirectories(root: string, count: number): string[] {
	const dirs: string[] = [];
	for (let i = 0; i < count; i++) {
		const dir = join(root, `dir-${i}`);
		mkdirSync(dir);
		dirs.push(dir);
	}
	return dirs;
}

function sessionHandle(cwd: string, initial: string[] = []): WorkspaceSessionDirectories {
	const dirs = [...initial];
	return {
		cwd,
		list: () => [...dirs],
		add: async directory => {
			if (dirs.includes(directory)) return null;
			dirs.push(directory);
			return directory;
		},
		remove: async directory => {
			const index = dirs.indexOf(directory);
			if (index === -1) return null;
			dirs.splice(index, 1);
			return directory;
		},
	};
}

describe("WorkspaceRegistry", () => {
	it("create/list/update/delete round-trips a managed project", async () => {
		const root = tempRoot();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		const registry = registryAt(root, () => 1_000);

		const created = await registry.create({ root: projectRoot, name: "Demo" });
		expect(created.workspace.kind).toBe("managed");
		expect(created.workspace.name).toBe("Demo");
		expect(created.workspace.id).toStartWith("wm_");
		expect(await registry.list()).toEqual([created.workspace]);

		const updated = await registry.update(created.workspace.id, { name: "Renamed" });
		expect(updated?.workspace.name).toBe("Renamed");
		expect(await registry.list()).toHaveLength(1);

		expect(await registry.delete(created.workspace.id)).toBe(true);
		expect(await registry.delete(created.workspace.id)).toBe(false);
		expect(await registry.list()).toEqual([]);
	});

	it("persists across registry instances (restart)", async () => {
		const root = tempRoot();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		await registryAt(root, () => 1_000).create({ root: projectRoot, name: "Persisted" });

		const reopened = registryAt(root, () => 2_000);
		const rows = await reopened.list();
		expect(rows.map(row => row.name)).toEqual(["Persisted"]);
	});

	it("backfills implicit projects from session cwds without duplicating managed roots", async () => {
		const root = tempRoot();
		const managedRoot = join(root, "managed");
		const otherRoot = join(root, "other");
		mkdirSync(managedRoot);
		mkdirSync(otherRoot);
		const registry = registryAt(root, () => 1_000);
		await registry.create({ root: managedRoot, name: "Managed" });

		const rows = await registry.list([managedRoot, otherRoot, otherRoot]);
		expect(rows).toHaveLength(2);
		const implicit = rows.find(row => row.root === otherRoot);
		expect(implicit?.kind).toBe("implicit");
		expect(implicit?.name).toBe("other");
		expect(implicit?.id).toStartWith("wd_other_");
	});

	it("deleted implicit projects are not resurrected by session cwd backfill", async () => {
		const root = tempRoot();
		const cwd = join(root, "history");
		const registry = registryAt(root, () => 1_000);
		const [implicit] = await registry.list([cwd]);
		expect(implicit.kind).toBe("implicit");

		expect(await registry.delete(implicit.id)).toBe(true);
		expect(await registry.list([cwd])).toEqual([]);
	});

	it("reports duplicate directories structurally instead of adding them twice", async () => {
		const root = tempRoot();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		const [dir] = makeDirectories(root, 1);
		const registry = registryAt(root);

		const first = await registry.create({ root: projectRoot, additionalDirs: [dir, dir] });
		expect(first.workspace.additionalDirs).toEqual([dir]);
		expect(first.duplicates).toHaveLength(1);
		expect(first.duplicates[0]).toEqual({ path: dir, directory: dir });

		const second = await registry.create({ root: projectRoot, additionalDirs: [dir] });
		expect(second.workspace.additionalDirs).toEqual([dir]);
		expect(second.duplicates).toEqual([{ path: dir, directory: dir }]);
	});

	it("rejects missing and non-directory paths with typed errors", async () => {
		const root = tempRoot();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		const file = join(root, "file.txt");
		writeFileSync(file, "x");
		const registry = registryAt(root);

		await expect(
			registry.create({ root: projectRoot, additionalDirs: [join(root, "missing")] }),
		).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_NOT_FOUND",
		});
		await expect(registry.create({ root: projectRoot, additionalDirs: [file] })).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_NOT_A_DIRECTORY",
		});
	});

	it(`caps additional directories at ${MAX_WORKSPACE_DIRECTORIES}`, async () => {
		const root = tempRoot();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		const dirs = makeDirectories(root, MAX_WORKSPACE_DIRECTORIES + 1);
		const registry = registryAt(root);

		const created = await registry.create({
			root: projectRoot,
			additionalDirs: dirs.slice(0, MAX_WORKSPACE_DIRECTORIES),
		});
		expect(created.workspace.additionalDirs).toHaveLength(MAX_WORKSPACE_DIRECTORIES);

		await expect(registry.create({ root: projectRoot, additionalDirs: dirs })).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_LIMIT",
		});
	});

	it("setPrimary swaps the root with a registered directory and preserves the id", async () => {
		const root = tempRoot();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		const [dir] = makeDirectories(root, 1);
		const registry = registryAt(root);
		const created = (await registry.create({ root: projectRoot, additionalDirs: [dir] })).workspace;

		const promoted = await registry.setPrimary(created.id, dir);
		expect(promoted?.id).toBe(created.id);
		expect(promoted?.root).toBe(dir);
		expect(promoted?.additionalDirs).toEqual([projectRoot]);

		await expect(registry.setPrimary(created.id, join(root, "outsider"))).rejects.toMatchObject({
			code: "WORKSPACE_DIRECTORY_NOT_IN_WORKSPACE",
		});
	});

	it("tolerates a malformed projects.json by starting empty", async () => {
		const root = tempRoot();
		writeFileSync(join(root, "projects.json"), "{not json");
		expect(await registryAt(root).list()).toEqual([]);
	});

	it("resolveWorkspaceDirectories normalizes relative inputs against the root", async () => {
		const root = tempRoot();
		const projectRoot = join(root, "project");
		mkdirSync(projectRoot);
		mkdirSync(join(projectRoot, "nested"));

		const resolved = await resolveWorkspaceDirectories(projectRoot, ["nested", "./nested", projectRoot]);
		expect(resolved.directories).toEqual([join(projectRoot, "nested")]);
		expect(resolved.duplicates).toEqual([
			{ path: "./nested", directory: join(projectRoot, "nested") },
			{ path: projectRoot, directory: projectRoot },
		]);
	});
});

describe("WorkspaceService session directories", () => {
	function service(handle: WorkspaceSessionDirectories | undefined, root: string): WorkspaceService {
		return new WorkspaceService({
			registry: registryAt(root),
			knownSessionCwds: async () => [],
			sessionDirectories: () => handle,
		});
	}

	it("add returns structured duplicate information for an existing directory", async () => {
		const root = tempRoot();
		const cwd = join(root, "workspace");
		const [dir] = makeDirectories(root, 1);
		const handle = sessionHandle(cwd, [dir]);
		const svc = service(handle, root);

		const result = await svc.addSessionDirectory({ sessionId: "s1", directory: dir });
		expect(result.added).toBe(false);
		expect(result.directory).toBeNull();
		expect(result.duplicate).toEqual({ path: dir, directory: dir });
		expect(handle.list()).toEqual([dir]);
	});

	it("add rejects missing directories and the 65th additional root", async () => {
		const root = tempRoot();
		const cwd = join(root, "workspace");
		const dirs = makeDirectories(root, MAX_WORKSPACE_DIRECTORIES);
		const handle = sessionHandle(cwd, dirs);
		const svc = service(handle, root);

		await expect(
			svc.addSessionDirectory({ sessionId: "s1", directory: join(root, "missing") }),
		).rejects.toBeInstanceOf(WorkspaceDirectoryError);
		await expect(
			svc.addSessionDirectory({ sessionId: "s1", directory: join(root, "one-too-many") }),
		).rejects.toMatchObject({ code: "WORKSPACE_DIRECTORY_LIMIT" });
	});

	it("list marks the primary directory and reports missing roots", async () => {
		const root = tempRoot();
		const cwd = join(root, "workspace");
		const [dir] = makeDirectories(root, 1);
		const svc = service(sessionHandle(cwd, [dir, join(root, "gone")]), root);

		const listed = await svc.listSessionDirectories({ sessionId: "s1" });
		expect(listed.directories).toEqual([
			{ path: cwd, primary: true, exists: false },
			{ path: dir, primary: false, exists: true },
			{ path: join(root, "gone"), primary: false, exists: false },
		]);
	});

	it("remove reports unknown directories as a no-op", async () => {
		const root = tempRoot();
		const handle = sessionHandle(join(root, "workspace"));
		const svc = service(handle, root);

		expect((await svc.removeSessionDirectory({ sessionId: "s1", directory: "nope" })).removed).toBe(false);
	});

	it("rejects directory operations for a session that is not live", async () => {
		const svc = service(undefined, tempRoot());
		await expect(svc.listSessionDirectories({ sessionId: "dead" })).rejects.toThrow(/Session not live/);
	});
});
