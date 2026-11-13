import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

interface TraySession {
	id: string;
}

interface TrayApproval {
	id: string;
	sessionId: string;
}

function liveSession(
	streaming: boolean,
	approvals: Map<string, { tool: string; prompt: string }>,
	extra: { asks?: Map<string, unknown>; tools?: Map<string, { toolName: string }> } = {},
) {
	return {
		agentSession: {
			isStreaming: streaming,
			sessionManager: { getSessionName: () => null },
		},
		approvals: { pending: approvals, pendingAsks: extra.asks ?? new Map() },
		activeToolCalls: extra.tools ?? new Map(),
		view: { snapshot: () => ({ state: { isStreaming: streaming } }) },
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

	test("session.list exposes background attention and the active tool", async () => {
		const rows = [
			{
				sessionId: "blocked",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				messageCount: 2,
				cwd: "",
				title: "Blocked",
			},
			{
				sessionId: "working",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				messageCount: 3,
				cwd: "",
				title: "Working",
			},
		];
		const lives = new Map([
			[
				"blocked",
				liveSession(true, new Map([["approval-1", { tool: "bash", prompt: "Run" }]]), {
					asks: new Map([["ask-1", {}]]),
					tools: new Map([["tool-1", { toolName: "grep" }]]),
				}),
			],
			["working", liveSession(true, new Map(), { tools: new Map([["tool-2", { toolName: "edit" }]]) })],
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
		const conn = { id: "session-list-test", send: () => {} } as DaemonConnection;
		const result = (await server.handle("session.list", undefined, conn)) as Array<{
			id: string;
			presence?: {
				phase: string;
				pendingApprovals: number;
				pendingQuestions: number;
				activeTool: string | null;
			};
		}>;

		expect(result.find(row => row.id === "blocked")).toMatchObject({
			presence: {
				phase: "awaiting-approval",
				pendingApprovals: 1,
				pendingQuestions: 1,
				activeTool: "grep",
			},
		});
		expect(result.find(row => row.id === "working")).toMatchObject({
			presence: {
				phase: "tool",
				pendingApprovals: 0,
				pendingQuestions: 0,
				activeTool: "edit",
			},
		});

		expect(await server.handle("session.presence", { sessionId: "blocked" }, conn)).toMatchObject({
			sessionId: "blocked",
			phase: "awaiting-approval",
			pendingApprovals: 1,
			pendingQuestions: 1,
			activeTool: "grep",
		});
	});
});
