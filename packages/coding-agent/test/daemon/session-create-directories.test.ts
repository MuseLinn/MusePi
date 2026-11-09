import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { MAX_WORKSPACE_DIRECTORIES, WorkspaceRegistry } from "../../src/daemon/services/workspace-registry";

/**
 * `session.create` additionalDirectories: the RPC boundary validates the
 * caller's list (existence, dedupe, 64-cap) before a session is spun up, then
 * merges the roots onto whatever the session already had. Project directories
 * registered for the cwd are defaults: they are inherited when the caller asks
 * for nothing, but a directory that no longer exists is skipped instead of
 * failing the create.
 */
async function harness(projectDirs: readonly string[] = []) {
	const root = mkdtempSync(join(tmpdir(), "musepi-session-create-dirs-"));
	const cwd = join(root, "workspace");
	const configured = join(root, "configured");
	mkdirSync(cwd);
	mkdirSync(configured);
	let dirs = [configured];
	let created: Record<string, unknown> | undefined;
	const manager = {
		getCwd: () => cwd,
		getAdditionalDirectories: () => [...dirs],
		setAdditionalDirectories: async (next: string[]) => {
			dirs = [...next];
		},
	};
	const host = {
		cwd: () => cwd,
		createSession: async (params: Record<string, unknown>) => {
			created = params;
			return { sessionId: "s-created" };
		},
		get: () => ({ sessionId: "s-created", agentSession: { sessionManager: manager, refreshSkills: async () => {} } }),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const registry = new WorkspaceRegistry({ filePath: join(root, "projects.json"), now: () => 1 });
	if (projectDirs.length > 0) await registry.create({ root: cwd, additionalDirs: [...projectDirs] });
	const server = new DaemonServer(host, { workspaceRegistry: registry });
	const conn = { id: "test" } as unknown as DaemonConnection;
	return { root, cwd, configured, server, conn, dirs: () => [...dirs], created: () => created };
}

describe("session.create additionalDirectories", () => {
	test("merges requested roots with directories the session already has", async () => {
		const h = await harness();
		const extra = join(h.root, "extra");
		mkdirSync(extra);

		const result = (await h.server.handle(
			"session.create",
			{ cwd: h.cwd, additionalDirectories: [extra] },
			h.conn,
		)) as { sessionId: string; additionalDirectories: string[] };

		expect(result.sessionId).toBe("s-created");
		expect(h.created()?.additionalDirectories).toEqual([extra]);
		expect(h.dirs()).toEqual([h.configured, extra]);
		expect(result.additionalDirectories).toEqual(h.dirs());
	});

	test("inherits project directories when the caller requests none", async () => {
		const extraRoot = mkdtempSync(join(tmpdir(), "musepi-project-extra-"));
		const extra = join(extraRoot, "extra");
		mkdirSync(extra);
		const h = await harness([extra]);

		const result = (await h.server.handle("session.create", { cwd: h.cwd }, h.conn)) as {
			sessionId: string;
			additionalDirectories: string[];
		};

		expect(result.sessionId).toBe("s-created");
		expect(h.dirs()).toEqual([h.configured, extra]);
		expect(result.additionalDirectories).toEqual([h.configured, extra]);
	});

	test("merges explicit roots on top of project directories", async () => {
		const extrasRoot = mkdtempSync(join(tmpdir(), "musepi-project-extras-"));
		const projectExtra = join(extrasRoot, "project");
		const explicit = join(extrasRoot, "explicit");
		mkdirSync(projectExtra);
		mkdirSync(explicit);
		const h = await harness([projectExtra]);

		const result = (await h.server.handle(
			"session.create",
			{ cwd: h.cwd, additionalDirectories: [explicit] },
			h.conn,
		)) as { additionalDirectories: string[] };

		expect(h.dirs()).toEqual([h.configured, projectExtra, explicit]);
		expect(result.additionalDirectories).toEqual(h.dirs());
	});

	test("skips a project directory that no longer exists", async () => {
		const goneRoot = mkdtempSync(join(tmpdir(), "musepi-project-gone-"));
		const gone = join(goneRoot, "gone");
		mkdirSync(gone);
		const h = await harness([gone]);
		rmSync(gone, { recursive: true, force: true });

		const result = (await h.server.handle("session.create", { cwd: h.cwd }, h.conn)) as Record<string, unknown>;

		expect(result).toEqual({ sessionId: "s-created" });
		expect(h.dirs()).toEqual([h.configured]);
	});

	test("reports duplicate roots without applying them twice", async () => {
		const h = await harness();
		const result = (await h.server.handle(
			"session.create",
			{ cwd: h.cwd, additionalDirectories: [h.configured, h.configured] },
			h.conn,
		)) as { duplicates: { path: string; directory: string }[] };

		expect(result.duplicates).toHaveLength(1);
		expect(h.dirs()).toEqual([h.configured]);
	});

	test("rejects a missing directory before creating a session", async () => {
		const h = await harness();
		await expect(
			h.server.handle("session.create", { cwd: h.cwd, additionalDirectories: [join(h.root, "missing")] }, h.conn),
		).rejects.toMatchObject({ code: "WORKSPACE_DIRECTORY_NOT_FOUND" });
		expect(h.created()).toBeUndefined();
	});

	test(`rejects more than ${MAX_WORKSPACE_DIRECTORIES} roots before creating a session`, async () => {
		const h = await harness();
		const dirs: string[] = [];
		for (let i = 0; i <= MAX_WORKSPACE_DIRECTORIES; i++) {
			const dir = join(h.root, `dir-${i}`);
			mkdirSync(dir);
			dirs.push(dir);
		}
		await expect(
			h.server.handle("session.create", { cwd: h.cwd, additionalDirectories: dirs }, h.conn),
		).rejects.toMatchObject({ code: "WORKSPACE_DIRECTORY_LIMIT" });
		expect(h.created()).toBeUndefined();
	});

	test("keeps the default creation path untouched when no directories are requested", async () => {
		const h = await harness();
		const result = (await h.server.handle("session.create", { cwd: h.cwd }, h.conn)) as Record<string, unknown>;

		expect(result).toEqual({ sessionId: "s-created" });
		expect(h.dirs()).toEqual([h.configured]);
	});
});
