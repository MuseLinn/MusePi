import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { WorkspaceRegistry } from "../../src/daemon/services/workspace-registry";

/**
 * A project directory added in one window must reach that project's open
 * sessions in every window. The daemon merges it into the session header and
 * rebuilds the prompt; a streaming session keeps the prompt it started with.
 */
async function harness(options: { streaming?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "musepi-workspace-live-"));
	const cwd = join(root, "workspace");
	const added = join(root, "references");
	mkdirSync(cwd);
	mkdirSync(added);
	let directories: string[] = [];
	let refreshed = 0;
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
			refreshSkills: async () => {
				refreshed += 1;
			},
		},
	};
	const host = {
		cwd: () => cwd,
		get: () => live,
		allSessions: () => [live],
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const registry = new WorkspaceRegistry({ filePath: join(root, "projects.json"), now: () => 1 });
	const project = await registry.create({ root: cwd, name: "P" });
	const server = new DaemonServer(host, { workspaceRegistry: registry });
	const conn = { id: "test" } as unknown as DaemonConnection;
	return {
		cwd,
		added,
		projectId: project.workspace.id,
		server,
		conn,
		directories: () => [...directories],
		refreshed: () => refreshed,
	};
}

describe("workspace directory propagation", () => {
	test("workspace.update merges a new project directory into an idle session", async () => {
		const h = await harness();

		await h.server.handle("workspace.update", { id: h.projectId, additionalDirs: [h.added] }, h.conn);

		expect(h.directories()).toEqual([h.added]);
		expect(h.refreshed()).toBe(1);
	});

	test("a streaming session is not modified mid-turn", async () => {
		const h = await harness({ streaming: true });

		await h.server.handle("workspace.update", { id: h.projectId, additionalDirs: [h.added] }, h.conn);

		expect(h.directories()).toEqual([]);
		expect(h.refreshed()).toBe(0);
	});
});
