/**
 * `session.agents` / `agents.transcript` identity contract.
 *
 * A subagent transcript has three ids — the file name (agent id the registry
 * and every agents.* RPC addresses), the `session` header id (`session.list`
 * row identity, what the GUI opens), and `session_init.agent` (which subagent
 * it was). These cases pin the daemon's answers after the child has finished
 * and left the registry, which is the state the GUI hits most often.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

const PARENT_ID = "01a1d5ba-a8f1-71f3-a247-6688e81c9d9b";
const PARENT_BASE = `2026-11-13T16-25-42-385Z_${PARENT_ID}`;
const CHILD_SESSION_ID = "01a1d5bb-6329-776e-950f-e6ab1609964b";

interface Row {
	sessionId: string;
	parentId: string | null;
	createdAt: number;
	updatedAt: number;
	title?: string;
	sessionFile?: string;
	subagent?: boolean;
	advisor?: boolean;
	agentName?: string;
}

function transcript(id: string, agent?: string, prompt = "collect the extension list"): string {
	return `${[
		JSON.stringify({ type: "session", version: 3, id, cwd: "/repo", timestamp: "2026-11-13T16:26:30.057Z" }),
		JSON.stringify({ type: "title", v: 1, title: "ListExtensionDirs", source: "auto" }),
		...(agent ? [JSON.stringify({ type: "session_init", agent })] : []),
		JSON.stringify({ type: "message", message: { role: "user", content: prompt } }),
	].join("\n")}\n`;
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

function scratchSession(): { rows: Row[]; parentFile: string; childFile: string; dir: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-subagent-roster-"));
	const parentFile = path.join(dir, `${PARENT_BASE}.jsonl`);
	const productDir = path.join(dir, PARENT_BASE);
	fs.mkdirSync(productDir, { recursive: true });
	fs.writeFileSync(parentFile, transcript(PARENT_ID));
	const childFile = path.join(productDir, "ListExtensionDirs.jsonl");
	fs.writeFileSync(childFile, transcript(CHILD_SESSION_ID, "sonic"));
	fs.writeFileSync(path.join(productDir, "__advisor.jsonl"), transcript("01a1d5be-0000-7000-8000-000000000000"));
	const rows: Row[] = [
		{ sessionId: PARENT_ID, parentId: null, createdAt: 1, updatedAt: 2, sessionFile: parentFile, title: "parent" },
		{
			sessionId: CHILD_SESSION_ID,
			parentId: PARENT_ID,
			createdAt: 3,
			updatedAt: 4,
			sessionFile: childFile,
			subagent: true,
			agentName: "sonic",
			title: "ListExtensionDirs",
		},
		{
			sessionId: "01a1d5be-0000-7000-8000-000000000000",
			parentId: PARENT_ID,
			createdAt: 3,
			updatedAt: 4,
			sessionFile: path.join(productDir, "__advisor.jsonl"),
			subagent: true,
			advisor: true,
			title: "advisor",
		},
	];
	return { rows, parentFile, childFile, dir };
}

describe("session.agents", () => {
	test("lists the disk roster with all three ids and excludes advisors", async () => {
		const { rows, dir } = scratchSession();
		try {
			const result = (await server(rows).handle("session.agents", { sessionId: PARENT_ID }, conn())) as {
				agents: {
					id: string;
					sessionId: string;
					displayName: string;
					agentName?: string | null;
					kind: string;
					status: string;
					activity?: string | null;
					lastActivity: number;
					hasSessionFile: boolean;
				}[];
			};
			expect(result.agents).toHaveLength(1);
			expect(result.agents[0]).toMatchObject({
				id: "ListExtensionDirs",
				sessionId: CHILD_SESSION_ID,
				displayName: "sonic",
				agentName: "sonic",
				kind: "sub",
				// Not in the registry (finished one-shot): presented as settled,
				// not as a revivable "parked" agent with a dead button.
				status: "idle",
				lastActivity: 4,
				hasSessionFile: true,
			});
			// The row's second line is the child session title (the assignment),
			// not the agent-id file name.
			expect(result.agents[0]?.activity).toBe("ListExtensionDirs");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a session with no children answers with an empty roster", async () => {
		const { rows, dir } = scratchSession();
		try {
			const result = (await server(rows).handle("session.agents", { sessionId: "unknown-session" }, conn())) as {
				agents: unknown[];
			};
			expect(result.agents).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("agents.transcript", () => {
	test("reads a finished child's transcript through the parent session id", async () => {
		const { rows, dir } = scratchSession();
		try {
			const result = (await server(rows).handle(
				"agents.transcript",
				{ agentId: "ListExtensionDirs", parentSessionId: PARENT_ID, fromByte: 0 },
				conn(),
			)) as { text: string; newSize: number; error?: string };
			expect(result.error).toBeUndefined();
			expect(result.text).toContain("collect the extension list");
			expect(result.newSize).toBeGreaterThan(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unknown agent still reports a missing transcript instead of another child", async () => {
		const { rows, dir } = scratchSession();
		try {
			const result = (await server(rows).handle(
				"agents.transcript",
				{ agentId: "NoSuchAgent", parentSessionId: PARENT_ID, fromByte: 0 },
				conn(),
			)) as { text: string; newSize: number; error?: string };
			expect(result).toEqual({ text: "", newSize: 0, error: "no transcript available" });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
