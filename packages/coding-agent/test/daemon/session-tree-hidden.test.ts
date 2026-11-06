import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionService, type SessionTreeRow } from "../../src/daemon/services/session-service";
import type { DeletedWorkspaces } from "../../src/daemon/services/workspace-registry";
import { normalizeWorkspaceDirectory } from "../../src/session/session-workspace";

function service(rows: SessionTreeRow[], deleted: DeletedWorkspaces): SessionService {
	return new SessionService({
		knownSessions: async () => rows,
		snapshot: async () => ({}),
		checkpointSeq: async () => 0,
		setResumeLive: () => {},
		cronSessionIds: () => new Set(),
		firstUserMessage: () => "",
		deletedWorkspaces: async () => deleted,
	});
}

function row(id: string, cwd: string | undefined, createdAt: number): SessionTreeRow {
	return { sessionId: id, parentId: null, createdAt, updatedAt: createdAt, cwd };
}

type TreeNode = { entry: { id: string } };
const ids = (tree: unknown[]): string[] => (tree as TreeNode[]).map(node => node.entry.id);

const root = normalizeWorkspaceDirectory(mkdtempSync(join(tmpdir(), "musepi-session-tree-")));

describe("session.tree hidden-workspace projection", () => {
	it("drops sessions of a currently removed workspace", async () => {
		const tree = await service([row("kept", undefined, 10), row("gone", root, 10)], {
			roots: new Set([root]),
			deletedAt: {},
		}).tree();
		expect(ids(tree)).toEqual(["kept"]);
	});

	it("after re-registering, keeps only sessions created after the removal", async () => {
		const tree = await service([row("before", root, 1_000), row("after", root, 2_000)], {
			roots: new Set(),
			deletedAt: { [root]: 1_500 },
		}).tree();
		expect(ids(tree)).toEqual(["after"]);
	});

	it("keeps every session when nothing was removed", async () => {
		const tree = await service([row("a", root, 10)], { roots: new Set(), deletedAt: {} }).tree();
		expect(ids(tree)).toEqual(["a"]);
	});
});
