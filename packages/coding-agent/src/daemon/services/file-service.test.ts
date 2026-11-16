import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileService } from "./file-service";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-file-service-"));
const other = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-file-service-other-"));
fs.mkdirSync(path.join(root, "notes"));
fs.writeFileSync(path.join(root, "notes", "a.txt"), "hello");
fs.writeFileSync(path.join(other, "outside.txt"), "outside");

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(other, { recursive: true, force: true });
});

function service(fallback = root): FileService {
	return new FileService({
		fallbackCwd: () => fallback,
		ensureFileIndex: () => {
			throw new Error("index not used by fs.readBytes");
		},
	});
}

describe("FileService.readBytes", () => {
	it("resolves a workspace.tree path against the session cwd", () => {
		const res = service().readBytes({ path: "notes/a.txt", cwd: root });
		expect(res.error).toBeUndefined();
		expect(Buffer.from(String(res.base64), "base64").toString("utf8")).toBe("hello");
		expect(res.mime).toBe("text/plain");
	});

	it("falls back to the workspace root when the caller sends no cwd", () => {
		const res = service().readBytes({ path: "notes/a.txt" });
		expect(res.error).toBeUndefined();
	});

	it("rejects a relative path that escapes the workspace", () => {
		const res = service().readBytes({ path: "../outside.txt", cwd: path.join(root, "notes") });
		expect(res.error).toBe("path escapes workspace");
	});

	it("still reads the absolute path the desktop file pane sends", () => {
		const res = service().readBytes({ path: path.join(other, "outside.txt") });
		expect(res.error).toBeUndefined();
		expect(Buffer.from(String(res.base64), "base64").toString("utf8")).toBe("outside");
	});

	it("refuses a file above the read cap", () => {
		fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(2048));
		const res = service().readBytes({ path: "big.bin", cwd: root, maxBytes: 16 });
		expect(String(res.error)).toContain("file too large");
	});
});
