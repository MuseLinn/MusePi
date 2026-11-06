import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { BlobProtocolHandler } from "@musepi/pi-coding-agent/internal-urls/blob-protocol";
import { parseInternalUrl } from "@musepi/pi-coding-agent/internal-urls/parse";
import { InternalUrlRouter } from "@musepi/pi-coding-agent/internal-urls/router";
import { BlobStore } from "@musepi/pi-coding-agent/session/blob-store";
import { getBlobsDir } from "@musepi/pi-utils";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

describe("blob:// resolution", () => {
	let isolatedAgentDir: string;
	const handler = new BlobProtocolHandler();

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("blob-protocol-");
		InternalUrlRouter.resetForTests();
	}, 30000);

	afterAll(async () => {
		InternalUrlRouter.resetForTests();
		await restoreAgentDirForTest(isolatedAgentDir);
	}, 30000);

	async function put(data: Buffer): Promise<string> {
		const { hash } = await new BlobStore(getBlobsDir()).put(data);
		return hash;
	}

	it("reads text blobs back byte-for-byte from the content-addressed path", async () => {
		const hash = await put(Buffer.from("blob contents\n"));

		const resource = await handler.resolve(parseInternalUrl(`blob://${hash}`));

		expect(resource.content).toBe("blob contents\n");
		expect(resource.size).toBe(14);
		expect(resource.sourcePath).toBe(path.join(getBlobsDir(), hash));
	});

	it("rejects non-hash suffixes instead of joining them into a path", async () => {
		await expect(handler.resolve(parseInternalUrl("blob://not-a-hash"))).rejects.toThrow(
			/64-character lowercase hexadecimal/,
		);
		await expect(handler.resolve(parseInternalUrl(`blob://${"A".repeat(64)}`))).rejects.toThrow(
			/64-character lowercase hexadecimal/,
		);
	});

	it("reports a missing blob instead of returning empty content", async () => {
		await expect(handler.resolve(parseInternalUrl(`blob://${"0".repeat(64)}`))).rejects.toThrow(/Blob not found/);
	});

	it("resolves pathOnly without materializing content", async () => {
		const hash = await put(Buffer.from("path only\n"));

		const resource = await handler.resolve(parseInternalUrl(`blob://${hash}`), { pathOnly: true });

		expect(resource.content).toBe("");
		expect(resource.size).toBe(10);
		expect(resource.sourcePath).toBe(path.join(getBlobsDir(), hash));
	});

	it("refuses to inline blobs above the 8 MiB cap, but still resolves pathOnly", async () => {
		const size = 9 * 1024 * 1024;
		const hash = await put(Buffer.alloc(size, 0x41));
		const url = parseInternalUrl(`blob://${hash}`);

		await expect(handler.resolve(url)).rejects.toThrow(/full internal resolution is blocked/);
		const pathOnly = await handler.resolve(url, { pathOnly: true });
		expect(pathOnly.size).toBe(size);
		expect(pathOnly.sourcePath).toBe(path.join(getBlobsDir(), hash));
	});

	it("rejects binary blobs before decoding them as text", async () => {
		const hash = await put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));

		await expect(handler.resolve(parseInternalUrl(`blob://${hash}`))).rejects.toThrow(/binary data/);
	});

	it("is registered with the router as an immutable resource", async () => {
		const hash = await put(Buffer.from("routed\n"));

		const resource = await InternalUrlRouter.instance().resolve(`blob://${hash}`);

		expect(resource.content).toBe("routed\n");
		expect(resource.immutable).toBe(true);
		expect(await InternalUrlRouter.instance().complete("blob", "")).toEqual([]);
	});
});
