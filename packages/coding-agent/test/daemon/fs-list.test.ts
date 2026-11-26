import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileService } from "../../src/daemon/services/file-service";

/**
 * `fs.list` is the picker behind "choose a workspace on this daemon's machine".
 *
 * It is deliberately not `workspace.tree`: that one scans a workspace, returns
 * cwd-relative paths and refuses anything outside it. This one answers "what
 * directories exist on this machine", so an absolute path is the input and a
 * failure is a field, not a throw.
 */

function service(): FileService {
	return new FileService({
		fallbackCwd: () => os.tmpdir(),
		ensureFileIndex: () => {
			throw new Error("not used by fs.list");
		},
	});
}

function fixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-fslist-"));
	fs.mkdirSync(path.join(dir, "zeta"));
	fs.mkdirSync(path.join(dir, "alpha"));
	fs.mkdirSync(path.join(dir, ".hidden"));
	fs.writeFileSync(path.join(dir, "note.txt"), "x");
	return dir;
}

describe("fs.list", () => {
	test("directories come first and hidden entries are opt-in", () => {
		const dir = fixture();
		const listed = service().list({ path: dir });
		expect(listed.entries.map(entry => entry.name)).toEqual(["alpha", "zeta", "note.txt"]);
		// A directory picker that hides dotted directories cannot select them.
		expect(service().list({ path: dir, showHidden: true }).entries.map(entry => entry.name)).toContain(".hidden");
	});

	test("the parent is reported, and a root has none", () => {
		const dir = fixture();
		expect(service().list({ path: dir }).parent).toBe(path.dirname(dir));
		const root = process.platform === "win32" ? "C:\\" : "/";
		expect(service().list({ path: root }).parent).toBeNull();
	});

	test("an unreadable path answers with a reason instead of throwing", () => {
		const missing = path.join(os.tmpdir(), "musepi-fslist-does-not-exist-xyz");
		const listed = service().list({ path: missing });
		expect(listed.entries).toEqual([]);
		expect(typeof listed.error).toBe("string");
		// The path still comes back, so the UI can show where it tried.
		expect(listed.path).toBe(path.resolve(missing));
	});

	test("no path means the home directory, not the workspace root", () => {
		// A picker opens somewhere useful; the daemon's cwd is not the user's home.
		expect(service().list({}).path).toBe(path.resolve(os.homedir()));
	});
});
