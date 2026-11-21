import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type DaemonConnection,
	DaemonServer,
	type DaemonSessionHost,
} from "../../../packages/coding-agent/src/daemon/server";

/**
 * `session.list` scoping contract (daemon rendered in-process).
 *
 * The chat capsule reads its own row with `{ sessionId }` instead of the whole
 * workspace, and the Agent tab's role comes from that same row. Pinning the
 * two facts that scoping could silently break:
 *  - a scoped read returns exactly the one row (and `[]` for an unknown id,
 *    the same answer as a list that does not contain it);
 *  - `agentCount` counts over the WHOLE listing, so a scoped parent row still
 *    reports its subagents. Counting over the returned rows made every scoped
 *    read report 0, which changed an existing field's meaning on a route that
 *    other surfaces reuse.
 */

const PARENT_ID = "01a1d5ba-a8f1-71f3-a247-6688e81c9d9b";
const CHILD_ID = "01a1d5bb-6329-776e-950f-e6ab1609964b";
const ADVISOR_ID = "01a1d5be-0000-7000-8000-000000000000";

interface Row {
	sessionId: string;
	parentId: string | null;
	createdAt: number;
	updatedAt: number;
	title?: string;
	subagent?: boolean;
	advisor?: boolean;
	agentName?: string;
}

interface ListedRow {
	id: string;
	parentId: string | null;
	subagent: boolean;
	advisor: boolean;
	agentName?: string;
	agentRole: { id: string; name?: string };
	agentCount: number;
	title?: string;
}

const scratchDirs: string[] = [];

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** One parent, one task subagent and one advisor child — the three identity
 *  shapes `session.list` derives a role for. The workspace service reads the
 *  sessions' directories, so each row gets a real (empty) session file. */
function fixture(): Row[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-session-list-scope-"));
	scratchDirs.push(dir);
	const file = (id: string): string => {
		const target = path.join(dir, `${id}.jsonl`);
		fs.writeFileSync(
			target,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: dir, timestamp: "2026-11-22T00:00:00.000Z" })}\n`,
		);
		return target;
	};
	const row = (id: string, parentId: string | null, extra: Partial<Row> = {}): Row => ({
		sessionId: id,
		parentId,
		createdAt: 1,
		updatedAt: 2,
		sessionFile: file(id),
		...extra,
	});
	return [
		row(PARENT_ID, null, { title: "parent" }),
		row(CHILD_ID, PARENT_ID, { subagent: true, agentName: "sonic", title: "Child" }),
		row(ADVISOR_ID, PARENT_ID, { subagent: true, advisor: true, title: "advisor" }),
	];
}

function server(rows: Row[]): DaemonServer {
	const host = {
		cwd: () => "/tmp",
		get: () => undefined,
		knownSessions: async () => rows,
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return new DaemonServer(host);
}

function conn(): DaemonConnection {
	return { id: "test" } as unknown as DaemonConnection;
}

async function list(rows: Row[], params: Record<string, unknown> = {}): Promise<ListedRow[]> {
	return (await server(rows).handle("session.list", params, conn())) as ListedRow[];
}

describe("session.list scoping", () => {
	it("returns one row for a sessionId scope and reads the same agentRole", async () => {
		const rows = fixture();
		const all = await list(rows);
		const scoped = await list(rows, { sessionId: CHILD_ID });

		expect(scoped).toHaveLength(1);
		expect(scoped[0]?.id).toBe(CHILD_ID);
		expect(scoped[0]?.agentRole).toEqual({ id: "subagent", name: "sonic" });
		// Scoping is a filter, not a different projection.
		expect(scoped[0]).toEqual(all.find(row => row.id === CHILD_ID)!);
	});

	it("answers an unknown id with an empty list", async () => {
		expect(await list(fixture(), { sessionId: "no-such-session" })).toEqual([]);
	});

	it("keeps agentCount over the whole listing on a scoped read", async () => {
		const rows = fixture();
		const all = await list(rows);
		const scoped = await list(rows, { sessionId: PARENT_ID });

		// The advisor child is not a task subagent, so it never inflates the count.
		expect(all.find(row => row.id === PARENT_ID)?.agentCount).toBe(1);
		expect(scoped[0]?.agentCount).toBe(1);
	});

	it("derives coder for the workbench row and advisor for the advisor row", async () => {
		const rows = fixture();
		const byId = new Map((await list(rows)).map(row => [row.id, row]));
		expect(byId.get(PARENT_ID)?.agentRole).toEqual({ id: "coder" });
		expect(byId.get(CHILD_ID)?.agentRole).toEqual({ id: "subagent", name: "sonic" });
		expect(byId.get(ADVISOR_ID)?.agentRole).toEqual({ id: "advisor" });
	});
});
