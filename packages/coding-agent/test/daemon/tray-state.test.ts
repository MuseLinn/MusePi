import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

interface TraySession {
	id: string;
}

interface TrayApproval {
	id: string;
	sessionId: string;
}

function liveSession(streaming: boolean, approvals: Map<string, { tool: string; prompt: string }>) {
	return {
		agentSession: {
			isStreaming: streaming,
			sessionManager: { getSessionName: () => null },
		},
		approvals: { pending: approvals },
		pauseGate: { paused: false },
		autoTitle: false,
	};
}

describe("tray.state ambient session projection", () => {
	test("lists and counts only main sessions but retains auxiliary approvals", async () => {
		const rows = [
			{ sessionId: "main", createdAt: Date.now(), messageCount: 2, cwd: "", title: "Main" },
			{ sessionId: "child", createdAt: Date.now(), messageCount: 4, cwd: "", title: "Child", subagent: true },
			{ sessionId: "advisor", createdAt: Date.now(), messageCount: 1, cwd: "", title: "Advisor", advisor: true },
		];
		const lives = new Map([
			["main", liveSession(true, new Map())],
			["child", liveSession(true, new Map([["approval-child", { tool: "bash", prompt: "Run a child command" }]]))],
			["advisor", liveSession(false, new Map())],
		]);
		const host = {
			cwd: () => process.cwd(),
			knownSessions: async () => rows,
			sessions: () => [...lives.keys()],
			get: (id: string) => lives.get(id),
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);
		const conn = { id: "tray-test", send: () => {} } as DaemonConnection;

		const result = (await server.handle("tray.state", undefined, conn)) as {
			sessions: TraySession[];
			activeCount: number;
			approvals: TrayApproval[];
		};

		expect(result.sessions.map(session => session.id)).toEqual(["main"]);
		expect(result.activeCount).toBe(1);
		expect(result.approvals).toEqual([expect.objectContaining({ id: "approval-child", sessionId: "child" })]);
	});
});
