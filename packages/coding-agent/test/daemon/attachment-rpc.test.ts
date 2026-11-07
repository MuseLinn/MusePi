import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getBlobsDir } from "@musepi/pi-utils";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

/**
 * The chunked upload RPC surface as a client sees it: begin → chunk → commit
 * across the JSON-RPC parameter names the switch casts. The service's own tests
 * cover assembly rules; this one covers the wiring between them.
 */
describe("attachment chunked upload RPC", () => {
	let isolatedAgentDir: string;
	// Built in beforeAll: the AttachmentService captures the blob directory in
	// its constructor, so the server must be created after agent-dir isolation
	// or the test writes into the production store.
	let server: DaemonServer;
	const host = {
		cwd: () => process.cwd(),
		get: () => undefined,
		activate: async () => undefined,
		subscribe: async () => ({ seq: 0 }),
		touch: () => {},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const conn = { id: "c1" } as unknown as DaemonConnection;

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("attachment-rpc-");
		server = new DaemonServer(host);
	}, 30000);

	afterAll(async () => {
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30000);

	test("assembles a file across three RPC calls and returns a readable reference", async () => {
		const CHUNK = 3 * 1024 * 1024;
		const head = Buffer.alloc(CHUNK, 0x42);
		const tail = Buffer.from("tail-bytes");

		const begun = (await server.handle(
			"attachment.begin",
			{ name: "big.bin", mimeType: "application/x-test", size: head.length + tail.length },
			conn,
		)) as { uploadId: string; chunkSize: number };
		expect(begun.chunkSize).toBe(CHUNK);

		await server.handle(
			"attachment.chunk",
			{ uploadId: begun.uploadId, index: 1, content: tail.toString("base64") },
			conn,
		);
		const afterHead = (await server.handle(
			"attachment.chunk",
			{ uploadId: begun.uploadId, index: 0, content: head.toString("base64") },
			conn,
		)) as { received: number; chunks: number };
		expect(afterHead).toEqual({ received: head.length + tail.length, chunks: 2 });

		const committed = (await server.handle("attachment.commit", { uploadId: begun.uploadId }, conn)) as {
			url: string;
			ref: { hash: string; size: number; name: string };
		};
		const expected = Buffer.concat([head, tail]);
		expect(committed.ref.hash).toBe(new Bun.SHA256().update(expected).digest("hex"));
		expect(committed.ref.size).toBe(expected.length);
		expect(committed.ref.name).toBe("big.bin");
		expect(committed.url).toBe(`blob://${committed.ref.hash}`);

		// The reference is a real blob on disk, addressed the same way read does.
		expect(await Bun.file(`${getBlobsDir()}/${committed.ref.hash}`).arrayBuffer()).toHaveLength(expected.length);
	});

	test("abort is accepted over RPC and leaves nothing to commit", async () => {
		const begun = (await server.handle("attachment.begin", { name: "x.bin" }, conn)) as { uploadId: string };
		expect(await server.handle("attachment.abort", { uploadId: begun.uploadId }, conn)).toEqual({ ok: true });
		expect(await server.handle("attachment.commit", { uploadId: begun.uploadId }, conn)).toEqual({
			error: "unknown upload",
		});
	});
});
