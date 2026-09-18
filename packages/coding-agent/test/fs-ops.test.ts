import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createWorkspaceDir,
	deleteWorkspaceEntry,
	renameWorkspaceEntry,
	resolveInCwd,
	writeWorkspaceFile,
} from "../src/daemon/fs-ops";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ops-test-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("resolveInCwd", () => {
	it("resolves relative paths inside the cwd", () => {
		expect(resolveInCwd(dir, "a/b.txt")).toBe(path.join(dir, "a/b.txt"));
		expect(resolveInCwd(dir, "b.txt")).toBe(path.join(dir, "b.txt"));
	});

	it("rejects `..` escapes and absolute paths", () => {
		expect(resolveInCwd(dir, "../evil.txt")).toBeNull();
		expect(resolveInCwd(dir, "a/../../evil.txt")).toBeNull();
		expect(resolveInCwd(dir, "/etc/passwd")).toBeNull();
		expect(resolveInCwd(dir, "")).toBeNull();
		expect(resolveInCwd("", "a.txt")).toBeNull();
	});

	it("allows the cwd itself and sibling subpaths", () => {
		expect(resolveInCwd(dir, "sub")).toBe(path.join(dir, "sub"));
	});
});

describe("writeWorkspaceFile", () => {
	it("creates nested files", () => {
		const res = writeWorkspaceFile(dir, "deep/nested/new.txt", "hello");
		expect(res.ok).toBe(true);
		expect(fs.readFileSync(path.join(dir, "deep/nested/new.txt"), "utf8")).toBe("hello");
	});

	it("overwrites existing files", () => {
		fs.writeFileSync(path.join(dir, "x.txt"), "old");
		const res = writeWorkspaceFile(dir, "x.txt", "new");
		expect(res.ok).toBe(true);
		expect(fs.readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("new");
	});

	it("rejects escapes without writing anything", () => {
		const res = writeWorkspaceFile(dir, "../escape.txt", "x");
		expect(res.ok).toBe(false);
		expect(res.error).toContain("escapes");
		expect(fs.existsSync(path.join(path.dirname(dir), "escape.txt"))).toBe(false);
	});

	it("decodes base64 content into binary bytes (GUI file attachments)", () => {
		// A PNG header + payload: writing the base64 TEXT would corrupt the
		// file — encoding:"base64" must land the decoded bytes on disk.
		const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xbe]);
		const b64 = Buffer.from(bytes).toString("base64");
		const res = writeWorkspaceFile(dir, "attachments/shot.png", b64, "base64");
		expect(res.ok).toBe(true);
		const onDisk = new Uint8Array(fs.readFileSync(path.join(dir, "attachments/shot.png")));
		expect(Array.from(onDisk)).toEqual(Array.from(bytes));
	});

	it("writes base64 payloads that are not valid UTF-8 as-is", () => {
		// 0xFF 0xFE alone is invalid UTF-8; a text write would mangle it.
		const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x02]);
		const b64 = Buffer.from(bytes).toString("base64");
		expect(writeWorkspaceFile(dir, "blob.bin", b64, "base64").ok).toBe(true);
		const onDisk = new Uint8Array(fs.readFileSync(path.join(dir, "blob.bin")));
		expect(Array.from(onDisk)).toEqual(Array.from(bytes));
	});
});

describe("createWorkspaceDir + renameWorkspaceEntry + deleteWorkspaceEntry", () => {
	it("creates, renames and deletes entries", () => {
		expect(createWorkspaceDir(dir, "sub").ok).toBe(true);
		expect(fs.statSync(path.join(dir, "sub")).isDirectory()).toBe(true);

		writeWorkspaceFile(dir, "sub/a.txt", "1");
		expect(renameWorkspaceEntry(dir, "sub/a.txt", "sub/b.txt").ok).toBe(true);
		expect(fs.existsSync(path.join(dir, "sub/a.txt"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "sub/b.txt"))).toBe(true);

		expect(deleteWorkspaceEntry(dir, "sub").ok).toBe(true);
		expect(fs.existsSync(path.join(dir, "sub"))).toBe(false);
	});

	it("rejects escaped rename/delete targets", () => {
		writeWorkspaceFile(dir, "keep.txt", "1");
		expect(renameWorkspaceEntry(dir, "keep.txt", "../out.txt").ok).toBe(false);
		expect(deleteWorkspaceEntry(dir, "../whatever").ok).toBe(false);
		expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
	});

	it("does not follow symlinks out of the workspace on delete", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ops-out-"));
		try {
			const victim = path.join(outside, "victim.txt");
			fs.writeFileSync(victim, "data");
			fs.symlinkSync(outside, path.join(dir, "link"));
			// deleting the symlink removes the LINK, not the target tree
			expect(deleteWorkspaceEntry(dir, "link").ok).toBe(true);
			expect(fs.existsSync(victim)).toBe(true);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});
