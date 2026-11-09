import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { WorkspaceRegistry } from "../../src/daemon/services/workspace-registry";

/**
 * `session.reload` reconciles the project registry into the live session before
 * reloading, and only reports directories it actually added. A busy session is
 * rejected instead of being interrupted.
 */
async function harness(
	options: { streaming?: boolean; projectDirs?: readonly string[]; cold?: boolean; reloadGate?: Promise<void> } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "musepi-session-reload-"));
	const cwd = join(root, "workspace");
	const sessionDir = join(root, "session-dir");
	mkdirSync(cwd);
	mkdirSync(sessionDir);
	let directories = [sessionDir];
	let reloadDelta: { added: string[]; removed: string[] } | undefined;
	let activated = false;
	let subscribed = false;
	const manager = {
		getCwd: () => cwd,
		getAdditionalDirectories: () => [...directories],
		setAdditionalDirectories: async (next: string[]) => {
			directories = [...next];
		},
	};
	const live = {
		sessionId: "s-live",
		agentSession: {
			isStreaming: options.streaming ?? false,
			isCompacting: false,
			sessionManager: manager,
			reloadFromDisk: async (delta: { added: string[]; removed: string[] }) => {
				await options.reloadGate;
				reloadDelta = delta;
				return { extensions: 0, errors: [] };
			},
			refreshSessionStart: async () => true,
		},
	};
	const host = {
		cwd: () => cwd,
		get: () => (options.cold && !activated ? undefined : live),
		allSessions: () => [live],
		subscribe: async () => {
			subscribed = true;
			activated = true;
			return { seq: 0 };
		},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const registry = new WorkspaceRegistry({ filePath: join(root, "projects.json"), now: () => 1 });
	if (options.projectDirs && options.projectDirs.length > 0) {
		await registry.create({ root: cwd, additionalDirs: [...options.projectDirs] });
	}
	const server = new DaemonServer(host, { workspaceRegistry: registry });
	const conn = { id: "test" } as unknown as DaemonConnection;
	return {
		root,
		cwd,
		sessionDir,
		server,
		conn,
		directories: () => [...directories],
		reloadDelta: () => reloadDelta,
		subscribed: () => subscribed,
	};
}

describe("session.reload", () => {
	test("merges newly registered project directories into the session", async () => {
		const root = mkdtempSync(join(tmpdir(), "musepi-reload-project-"));
		const projectDir = join(root, "project-extra");
		mkdirSync(projectDir);
		const h = await harness({ projectDirs: [projectDir] });

		const result = (await h.server.handle("session.reload", { sessionId: "s-live" }, h.conn)) as {
			ok: boolean;
			extensions: number;
		};

		expect(result).toMatchObject({ ok: true, extensions: 0 });
		expect(h.directories()).toEqual([h.sessionDir, projectDir]);
		expect(h.reloadDelta()).toEqual({ added: [projectDir], removed: [] });
	});

	test("reports no directory delta when the project adds nothing", async () => {
		const h = await harness();

		await h.server.handle("session.reload", { sessionId: "s-live" }, h.conn);

		expect(h.directories()).toEqual([h.sessionDir]);
		expect(h.reloadDelta()).toEqual({ added: [], removed: [] });
	});

	test("keeps a session-scoped directory the project registry does not know", async () => {
		const root = mkdtempSync(join(tmpdir(), "musepi-reload-keep-"));
		const projectDir = join(root, "project-extra");
		mkdirSync(projectDir);
		const h = await harness({ projectDirs: [projectDir] });

		await h.server.handle("session.reload", { sessionId: "s-live" }, h.conn);

		expect(h.directories()).toContain(h.sessionDir);
	});

	test("rejects a busy session without reloading it", async () => {
		const h = await harness({ streaming: true });

		await expect(h.server.handle("session.reload", { sessionId: "s-live" }, h.conn)).rejects.toThrow(
			"Session is busy",
		);
		expect(h.reloadDelta()).toBeUndefined();
	});

	test("activates a cold history session before reloading it", async () => {
		const h = await harness({ cold: true });

		await h.server.handle("session.reload", { sessionId: "s-live" }, h.conn);

		expect(h.subscribed()).toBe(true);
		expect(h.reloadDelta()).toBeDefined();
	});

	test("rejects a second reload while one is in flight", async () => {
		let release!: () => void;
		const reloadGate = new Promise<void>(resolve => {
			release = resolve;
		});
		const h = await harness({ reloadGate });

		const first = h.server.handle("session.reload", { sessionId: "s-live" }, h.conn);
		await expect(h.server.handle("session.reload", { sessionId: "s-live" }, h.conn)).rejects.toThrow(
			"already reloading",
		);
		release();
		await first;
	});
});
