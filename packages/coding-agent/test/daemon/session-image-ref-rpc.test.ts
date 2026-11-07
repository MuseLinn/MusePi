import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getBlobsDir } from "@musepi/pi-utils";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { BlobStore } from "../../src/session/blob-store";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * `session.send` accepts a content-addressed image reference as well as inline
 * base64, so a client that never holds the bytes (another device, a replay of a
 * persisted message) can still send an image. The daemon resolves it before the
 * content parts reach the agent; a ref that no longer resolves fails the send
 * rather than handing the provider an empty image.
 */
describe("session.send image references", () => {
	let isolatedAgentDir: string;
	const sent: unknown[] = [];
	const live = {
		sessionId: "s1",
		autoTitle: false,
		clientRequests: new Map<string, string>(),
		clientRequestIndexBuilt: true,
		agentSession: {
			sendUserMessage: (content: unknown) => {
				sent.push(content);
				return Promise.resolve();
			},
			sessionManager: { getEntries: () => [] },
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
	// Built after agent-dir isolation: services capture their storage paths in
	// the constructor.
	let server: DaemonServer;
	const conn = { id: "c1" } as unknown as DaemonConnection;

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("image-ref-rpc-");
		server = new DaemonServer(host);
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30000);

	test("resolves a blob reference into the base64 the agent receives", async () => {
		sent.length = 0;
		const bytes = Buffer.from("not-really-a-png-but-this-is-a-wire-test", "utf8");
		const { hash } = await new BlobStore(getBlobsDir()).put(bytes);

		await server.handle(
			"session.send",
			{
				sessionId: "s1",
				text: "看看这张图",
				images: [{ type: "image", mimeType: "image/png", data: `blob:sha256:${hash}` }],
			},
			conn,
		);

		const parts = sent[0] as Array<{ type: string; data?: string; mimeType?: string }>;
		const image = parts.find(part => part.type === "image");
		expect(image?.mimeType).toBe("image/png");
		expect(image?.data).toBe(bytes.toString("base64"));
	});

	test("fails the send when the referenced blob is gone", async () => {
		sent.length = 0;
		await expect(
			server.handle(
				"session.send",
				{
					sessionId: "s1",
					text: "旧附件",
					images: [{ type: "image", mimeType: "image/png", data: `blob:sha256:${"a".repeat(64)}` }],
				},
				conn,
			),
		).rejects.toThrow(/Attachment expired/);
		expect(sent).toHaveLength(0);
	});
});
