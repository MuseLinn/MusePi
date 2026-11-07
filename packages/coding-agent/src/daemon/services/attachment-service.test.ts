import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../session/blob-store";
import { AttachmentService } from "./attachment-service";

const roots: string[] = [];

function service(): { service: AttachmentService; store: BlobStore } {
	const root = mkdtempSync(join(tmpdir(), "musepi-attachments-"));
	roots.push(root);
	const store = new BlobStore(root);
	return { service: new AttachmentService({ store }), store };
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const b64 = (text: string) => Buffer.from(text).toString("base64");
const sha256 = (data: Buffer) => new Bun.SHA256().update(data).digest("hex");

describe("attachment.put", () => {
	test("stores the decoded bytes under their content hash", async () => {
		const { service: svc, store } = service();
		const bytes = Buffer.from("hello");
		const result = await svc.put({ name: "notes.txt", mimeType: "text/plain", content: bytes.toString("base64") });
		if ("error" in result) throw new Error(result.error);

		expect(result.ref).toEqual({
			scheme: "blob",
			hash: sha256(bytes),
			size: bytes.length,
			mimeType: "text/plain",
			name: "notes.txt",
		});
		expect(result.url).toBe(`blob://${sha256(bytes)}`);
		// The URL the prompt carries is resolvable by the blob protocol, which
		// reads the same store directory.
		expect((await store.get(sha256(bytes)))?.toString()).toBe("hello");
	});

	test("rejects malformed base64 instead of storing silent garbage", async () => {
		const { service: svc } = service();
		expect(await svc.put({ name: "a.bin", content: "not base64!" })).toEqual({ error: "invalid base64 content" });
		// Unpadded input decodes to a different byte count than the sender meant.
		expect(await svc.put({ name: "a.bin", content: "aGVsbG8" })).toEqual({ error: "invalid base64 content" });
	});

	test("requires a name and defaults an empty MIME type", async () => {
		const { service: svc } = service();
		expect(await svc.put({ name: "  ", content: b64("x") })).toEqual({ error: "missing name" });
		const result = await svc.put({ name: "a.bin", mimeType: "", content: b64("x") });
		if ("error" in result) throw new Error(result.error);
		expect(result.ref.mimeType).toBe("application/octet-stream");
	});
});

describe("attachment.get", () => {
	test("returns one page and the full size", async () => {
		const { service: svc } = service();
		const bytes = Buffer.from("0123456789abcdefghij");
		const put = await svc.put({ name: "a.bin", content: bytes.toString("base64") });
		if ("error" in put) throw new Error(put.error);

		const page = await svc.get({ hash: put.ref.hash, offset: 5, limit: 5 });
		if ("error" in page) throw new Error(page.error);
		expect(Buffer.from(page.content, "base64").toString()).toBe("56789");
		expect(page.size).toBe(bytes.length);
		expect(page.offset).toBe(5);
	});

	test("caps a page at 8 MiB even when the caller asks for more", async () => {
		const { service: svc, store } = service();
		const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
		const { hash } = await store.put(bytes);

		const page = await svc.get({ hash, limit: 64 * 1024 * 1024 });
		if ("error" in page) throw new Error(page.error);
		expect(Buffer.from(page.content, "base64").length).toBe(8 * 1024 * 1024);
		expect(page.size).toBe(bytes.length);
	});

	test("rejects out-of-range offsets, missing blobs and malformed hashes", async () => {
		const { service: svc } = service();
		const put = await svc.put({ name: "a.bin", content: b64("abc") });
		if ("error" in put) throw new Error(put.error);

		expect(await svc.get({ hash: put.ref.hash, offset: 4 })).toEqual({ error: "offset out of range" });
		expect(await svc.get({ hash: put.ref.hash, limit: 0 })).toEqual({ error: "invalid limit" });
		expect(await svc.get({ hash: "a".repeat(64) })).toEqual({ error: "blob not found" });
		expect(await svc.get({ hash: "../../etc/passwd" })).toEqual({ error: "invalid hash" });
	});
});

describe("attachment.putFile", () => {
	test("stores a same-machine file by path, bytes never entering the RPC body", async () => {
		const { service: svc } = service();
		const dir = mkdtempSync(join(tmpdir(), "musepi-putfile-"));
		roots.push(dir);
		const source = join(dir, "报销单.md");
		writeFileSync(source, "# 内容\n");

		const result = await svc.putFile({ path: source, mimeType: "text/markdown" });
		if ("error" in result) throw new Error(result.error);

		expect(result.ref.name).toBe("报销单.md");
		expect(result.ref.size).toBe(Buffer.byteLength("# 内容\n"));
		expect(result.ref.hash).toBe(sha256(Buffer.from("# 内容\n")));
		expect(await svc.stat({ hash: result.ref.hash })).toEqual({ exists: true, size: result.ref.size });
	});

	test("an explicit name wins over the path basename", async () => {
		const { service: svc } = service();
		const dir = mkdtempSync(join(tmpdir(), "musepi-putfile-"));
		roots.push(dir);
		const source = join(dir, "a.bin");
		writeFileSync(source, "x");

		const result = await svc.putFile({ path: source, name: "报告.pdf" });
		if ("error" in result) throw new Error(result.error);
		expect(result.ref.name).toBe("报告.pdf");
	});

	test("soft-errors for a missing path and for a directory", async () => {
		const { service: svc } = service();
		const dir = mkdtempSync(join(tmpdir(), "musepi-putfile-"));
		roots.push(dir);

		expect(await svc.putFile({ path: join(dir, "absent.bin") })).toEqual({ error: "file not found" });
		expect(await svc.putFile({ path: dir })).toEqual({ error: "not a regular file" });
		expect(await svc.putFile({})).toEqual({ error: "missing path" });
	});
});

describe("attachment.begin / chunk / commit / abort", () => {
	test("assembles chunks in any order and commits the same reference put would", async () => {
		const { service: svc } = service();
		const CHUNK = 3 * 1024 * 1024;
		const head = Buffer.alloc(CHUNK, 0x41);
		const tail = Buffer.from("tail");
		const begun = await svc.begin({ name: "a.bin", mimeType: "application/x-test", size: head.length + tail.length });
		if ("error" in begun) throw new Error(begun.error);

		// Deliberately out of order: chunk 1 carries the tail at its own offset.
		const second = await svc.chunk({ uploadId: begun.uploadId, index: 1, content: tail.toString("base64") });
		const first = await svc.chunk({ uploadId: begun.uploadId, index: 0, content: head.toString("base64") });
		expect(second).toEqual({ received: tail.length, chunks: 1 });
		expect(first).toEqual({ received: head.length + tail.length, chunks: 2 });

		const committed = await svc.commit({ uploadId: begun.uploadId });
		if ("error" in committed) throw new Error(committed.error);
		const expected = Buffer.concat([head, tail]);
		expect(committed.ref.hash).toBe(sha256(expected));
		expect(committed.ref.size).toBe(expected.length);
		expect(committed.ref.name).toBe("a.bin");
		expect(committed.ref.mimeType).toBe("application/x-test");
		// The temp file is gone after commit.
		expect(await svc.chunk({ uploadId: begun.uploadId, index: 0, content: "" })).toEqual({
			error: "unknown upload",
		});
	});

	test("rejects a short middle chunk instead of storing a sparse file", async () => {
		const { service: svc } = service();
		const begun = await svc.begin({ name: "short.bin" });
		if ("error" in begun) throw new Error(begun.error);
		await svc.chunk({ uploadId: begun.uploadId, index: 0, content: Buffer.from("abc").toString("base64") });
		await svc.chunk({ uploadId: begun.uploadId, index: 1, content: "YQ==" });

		expect(await svc.commit({ uploadId: begun.uploadId })).toEqual({
			error: `chunk 0 is 3 bytes; expected ${3 * 1024 * 1024}`,
		});
	});

	test("rejects a commit whose size does not match the declared total", async () => {
		const { service: svc } = service();
		const begun = await svc.begin({ name: "b.bin", size: 10 });
		if ("error" in begun) throw new Error(begun.error);
		await svc.chunk({ uploadId: begun.uploadId, index: 0, content: Buffer.from("short").toString("base64") });

		expect(await svc.commit({ uploadId: begun.uploadId })).toEqual({
			error: "size mismatch (5 of 10 bytes)",
		});
	});

	test("refuses to commit across a hole", async () => {
		const { service: svc } = service();
		const begun = await svc.begin({ name: "c.bin" });
		if ("error" in begun) throw new Error(begun.error);
		await svc.chunk({ uploadId: begun.uploadId, index: 0, content: "YQ==" });
		await svc.chunk({ uploadId: begun.uploadId, index: 2, content: "Yg==" });

		expect(await svc.commit({ uploadId: begun.uploadId })).toEqual({ error: "missing chunk 1" });
	});

	test("abort drops the upload and is idempotent", async () => {
		const { service: svc } = service();
		const begun = await svc.begin({ name: "d.bin" });
		if ("error" in begun) throw new Error(begun.error);

		expect(await svc.abort({ uploadId: begun.uploadId })).toEqual({ ok: true });
		expect(await svc.abort({ uploadId: begun.uploadId })).toEqual({ ok: true });
		expect(await svc.commit({ uploadId: begun.uploadId })).toEqual({ error: "unknown upload" });
	});

	test("rejects malformed chunks and unknown uploads", async () => {
		const { service: svc } = service();
		const begun = await svc.begin({ name: "e.bin" });
		if ("error" in begun) throw new Error(begun.error);

		expect(await svc.chunk({ uploadId: begun.uploadId, index: 0, content: "not base64!" })).toEqual({
			error: "invalid base64 content",
		});
		expect(await svc.chunk({ uploadId: begun.uploadId, index: -1, content: "YQ==" })).toEqual({
			error: "invalid chunk index",
		});
		expect(await svc.chunk({ uploadId: "nope", index: 0, content: "YQ==" })).toEqual({ error: "unknown upload" });
		await svc.abort({ uploadId: begun.uploadId });
	});
});

describe("attachment.stat", () => {
	test("reports size for a stored blob and false for anything else", async () => {
		const { service: svc } = service();
		const put = await svc.put({ name: "a.bin", content: b64("abc") });
		if ("error" in put) throw new Error(put.error);

		expect(await svc.stat({ hash: put.ref.hash })).toEqual({ exists: true, size: 3 });
		expect(await svc.stat({ hash: "a".repeat(64) })).toEqual({ exists: false, size: 0 });
		// A traversal-shaped hash must not turn the probe into a filesystem
		// existence oracle outside the blob directory.
		expect(await svc.stat({ hash: "../sessions/x" })).toEqual({ exists: false, size: 0 });
	});
});
