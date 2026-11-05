/**
 * `session.jobOutput` contract: forwards the requested tail to the session,
 * returns the job's live-output tail with its truncation flag, and fails
 * explicitly for jobs the session cannot resolve.
 */
import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

function createServer(getAsyncJobOutput: (jobId: string, options?: { tail?: number }) => unknown): DaemonServer {
	const host = {
		cwd: () => "/tmp",
		get: () => ({ sessionId: "s1", agentSession: { getAsyncJobOutput } }),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return new DaemonServer(host);
}

const conn = { id: "test" } as unknown as DaemonConnection;

describe("session.jobs question projection", () => {
	test("reports a background question job with the wire type 'question'", async () => {
		const host = {
			cwd: () => "/tmp",
			get: () => ({
				sessionId: "s1",
				agentSession: {
					getAsyncJobSnapshot: () => ({
						running: [
							{
								id: "bg_1",
								type: "task",
								status: "running",
								label: "Ask: Which auth?",
								startTime: 1,
								questionCount: 1,
								toolCallId: "call-1",
								outputBytes: 12,
							},
							{ id: "bg_2", type: "bash", status: "running", label: "bun test", startTime: 2, outputBytes: 0 },
						],
						recent: [],
						delivery: { queued: 0, delivering: false, pendingJobIds: [] },
					}),
					asyncJobManager: {
						getJob: (id: string) => (id === "bg_1" ? { id, kind: "question" } : { id }),
					},
				},
			}),
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);

		const result = (await server.handle("session.jobs", { sessionId: "s1" }, conn)) as {
			running: Array<Record<string, unknown>>;
		};

		expect(result.running[0]).toMatchObject({
			id: "bg_1",
			type: "question",
			questionCount: 1,
			toolCallId: "call-1",
			outputBytes: 12,
		});
		expect(result.running[1]?.type).toBe("bash");
	});
});

describe("session.jobOutput RPC", () => {
	test("returns the requested tail with its truncation flag", async () => {
		const calls: Array<{ jobId: string; options?: { tail?: number } }> = [];
		const server = createServer((jobId, options) => {
			calls.push({ jobId, options });
			return { output: "ummary", truncated: true };
		});

		const result = await server.handle("session.jobOutput", { sessionId: "s1", jobId: "bg_1", tail: 6 }, conn);

		expect(result).toEqual({ output: "ummary", truncated: true });
		expect(calls).toEqual([{ jobId: "bg_1", options: { tail: 6 } }]);
	});

	test("omits the tail option when the caller does not send one", async () => {
		const calls: Array<{ jobId: string; options?: { tail?: number } }> = [];
		const server = createServer((jobId, options) => {
			calls.push({ jobId, options });
			return { output: "full output", truncated: false };
		});

		await server.handle("session.jobOutput", { sessionId: "s1", jobId: "bg_2" }, conn);

		expect(calls).toEqual([{ jobId: "bg_2", options: undefined }]);
	});

	test("fails explicitly for a job the session cannot resolve", async () => {
		const server = createServer(() => undefined);

		await expect(server.handle("session.jobOutput", { sessionId: "s1", jobId: "bg_missing" }, conn)).rejects.toThrow(
			"Unknown job: bg_missing",
		);
	});

	test("fails for an unknown session", async () => {
		const host = {
			cwd: () => "/tmp",
			get: () => undefined,
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);

		await expect(server.handle("session.jobOutput", { sessionId: "nope", jobId: "bg_1" }, conn)).rejects.toThrow(
			"Unknown session: nope",
		);
	});
});
