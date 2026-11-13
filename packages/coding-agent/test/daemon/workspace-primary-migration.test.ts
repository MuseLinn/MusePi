import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { WorkspaceRegistry } from "../../src/daemon/services/workspace-registry";
import { SessionManager } from "../../src/session/session-manager";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

let isolatedDir: string;

beforeAll(async () => {
	isolatedDir = await isolateAgentDirForTest("musepi-primary-migration-");
});

afterAll(async () => {
	await restoreAgentDirForTest(isolatedDir);
}, 30000);

describe("workspace primary migration", () => {
	test("moves persisted sessions to the new primary root", async () => {
		const oldRoot = path.join(isolatedDir, "old");
		const newRoot = path.join(isolatedDir, "new");
		await fs.mkdir(oldRoot, { recursive: true });
		await fs.mkdir(newRoot, { recursive: true });

		const sessionFile = SessionManager.createEmptySessionFile(oldRoot);
		if (!sessionFile) throw new Error("session file was not created");

		const registry = new WorkspaceRegistry({ filePath: path.join(isolatedDir, "projects.json") });
		const created = await registry.create({ root: oldRoot, additionalDirs: [newRoot] });
		await registry.setPrimary(created.workspace.id, newRoot);

		const movedPath = path.join(SessionManager.getDefaultSessionDir(newRoot), path.basename(sessionFile));
		const lines = (await fs.readFile(movedPath, "utf8")).split("\n");
		const header = JSON.parse(lines[1]!);
		expect(header.cwd).toBe(path.resolve(newRoot));

		const projects = await registry.list([]);
		expect(projects[0]?.root).toBe(path.resolve(newRoot));
		expect(projects[0]?.additionalDirs).toContain(path.resolve(oldRoot));
	});
});
