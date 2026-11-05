import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { MAX_WORKSPACE_DIRECTORIES } from "../../src/daemon/services/workspace-registry";

/**
 * `session.create` additionalDirectories: the RPC boundary validates the
 * caller's list (existence, dedupe, 64-cap) before a session is spun up, then
 * merges the roots onto whatever the session already had. The observable
 * contract is the SessionManager's directory set — not the request params.
 */
function harness() {
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
		get: () => ({ sessionId: "s-created", agentSession: { sessionManager: manager } }),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test" } as unknown as DaemonConnection;
	return { root, cwd, configured, server, conn, dirs: () => [...dirs], created: () => created };
}

describe("session.create additionalDirectories", () => {
	test("merges requested roots with directories the session already has", async () => {
		const h = harness();
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

	test("reports duplicate roots without applying them twice", async () => {
		const h = harness();
		const result = (await h.server.handle(
			"session.create",
			{ cwd: h.cwd, additionalDirectories: [h.configured, h.configured] },
			h.conn,
		)) as { duplicates: { path: string; directory: string }[] };

		expect(result.duplicates).toHaveLength(1);
		expect(h.dirs()).toEqual([h.configured]);
	});

	test("rejects a missing directory before creating a session", async () => {
		const h = harness();
		await expect(
			h.server.handle("session.create", { cwd: h.cwd, additionalDirectories: [join(h.root, "missing")] }, h.conn),
		).rejects.toMatchObject({ code: "WORKSPACE_DIRECTORY_NOT_FOUND" });
		expect(h.created()).toBeUndefined();
	});

	test(`rejects more than ${MAX_WORKSPACE_DIRECTORIES} roots before creating a session`, async () => {
		const h = harness();
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
		const h = harness();
		const result = (await h.server.handle("session.create", { cwd: h.cwd }, h.conn)) as Record<string, unknown>;

		expect(result).toEqual({ sessionId: "s-created" });
		expect(h.dirs()).toEqual([h.configured]);
	});
});
