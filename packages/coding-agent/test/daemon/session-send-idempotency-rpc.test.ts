import { describe, expect, test } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * `session.send` idempotency contract: a retried send from the same device and
 * request id must acknowledge the original without appending a second user
 * message; reusing the id for different content is a conflict.
 *
 * The second test clears the in-memory map to model a daemon restart: the
 * index must rebuild from the persisted user-message fields.
 */
describe("session.send idempotency", () => {
	const sent: string[] = [];
	const entries: Array<{
		type: "message";
		message: {
			role: "user";
			content: string;
			requestIdentity?: string;
			requestFingerprint?: string;
		};
	}> = [];
	const live = {
		sessionId: "s1",
		autoTitle: false,
		clientRequests: new Map<string, string>(),
		clientRequestIndexBuilt: false,
		agentSession: {
			sendUserMessage: (content: string, options?: { requestIdentity?: string; requestFingerprint?: string }) => {
				sent.push(content);
				entries.push({
					type: "message",
					message: {
						role: "user",
						content,
						...(options?.requestIdentity ? { requestIdentity: options.requestIdentity } : {}),
						...(options?.requestFingerprint ? { requestFingerprint: options.requestFingerprint } : {}),
					},
				});
				return Promise.resolve();
			},
			sessionManager: { getEntries: () => entries },
		},
	};
	const host = {
		cwd: () => process.cwd(),
		get: (id: string) => (id === "s1" ? live : undefined),
		activate: async () => live,
		subscribe: async () => ({ seq: 0 }),
		touch: () => {},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "c1" } as unknown as DaemonConnection;
	const send = (text: string) =>
		server.handle(
			"session.send",
			{ sessionId: "s1", text, clientId: "device-a", clientRequestId: "request-1" },
			conn,
		);

	test("same identity + same content acknowledges once", async () => {
		sent.length = 0;
		entries.length = 0;
		live.clientRequests.clear();
		live.clientRequestIndexBuilt = false;
		expect(await send("hello")).toEqual({ accepted: true });
		expect(sent).toEqual(["hello"]);
		expect(await send("hello")).toEqual({ accepted: true, duplicate: true });
		expect(sent).toEqual(["hello"]);
	});

	test("after a restart the index rebuilds from the persisted message", async () => {
		sent.length = 0;
		entries.length = 0;
		live.clientRequests.clear();
		live.clientRequestIndexBuilt = false;
		await send("durable");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.message.requestIdentity).toBe("msg:device-a:request-1");

		// Model a daemon restart: memory is gone, the session file is not.
		live.clientRequests.clear();
		live.clientRequestIndexBuilt = false;
		expect(await send("durable")).toEqual({ accepted: true, duplicate: true });
		expect(sent).toEqual(["durable"]);
		expect(entries).toHaveLength(1);
	});

	test("same identity + different content conflicts", async () => {
		sent.length = 0;
		entries.length = 0;
		live.clientRequests.clear();
		live.clientRequestIndexBuilt = false;
		await send("first");
		await expect(send("second")).rejects.toThrow(/Request conflict/);
		expect(sent).toEqual(["first"]);
	});
});
