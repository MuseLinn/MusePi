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
