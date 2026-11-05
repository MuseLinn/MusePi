import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileType, listWorkspace } from "@musepi/pi-natives";
import { FileService } from "../../src/daemon/services/file-service";

/**
 * `workspace.tree` follows directory symlinks that stay inside the workspace so
 * the file pane can expand them, and leaves links that point outside as leaf
 * entries. The native scan keeps `FollowLinks::Never` as its default; the
 * file service opts in explicitly.
 *
 * Directory links are created as Windows junctions when possible, which need no
 * developer mode. On hosts where even that fails (locked-down Windows without
 * the privilege), the suite skips instead of asserting on a link it could not
 * create.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-symlink-test-"));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-symlink-outside-"));
fs.mkdirSync(path.join(dir, "real", "nested"), { recursive: true });
fs.mkdirSync(path.join(dir, "other"), { recursive: true });
fs.writeFileSync(path.join(dir, "real", "nested", "child.md"), "child");
fs.writeFileSync(path.join(dir, "other", "sibling.md"), "sibling");
fs.writeFileSync(path.join(outsideDir, "secret.md"), "secret");

function trySymlink(target: string, linkPath: string, type: "dir" | "file"): boolean {
	try {
		fs.symlinkSync(target, linkPath, type === "dir" && process.platform === "win32" ? "junction" : type);
		return true;
	} catch {
		return false;
	}
}

const links: string[] = [];
const linkedDir = trySymlink(path.join(dir, "real"), path.join(dir, "link-dir"), "dir");
if (linkedDir) links.push(path.join(dir, "link-dir"));
const linkedOutside = trySymlink(outsideDir, path.join(dir, "link-out"), "dir");
if (linkedOutside) links.push(path.join(dir, "link-out"));
const linkedFile = trySymlink(path.join(dir, "real", "nested", "child.md"), path.join(dir, "child-link.md"), "file");
if (linkedFile) links.push(path.join(dir, "child-link.md"));
const linkedLoop = linkedDir && trySymlink(dir, path.join(dir, "real", "nested", "loop"), "dir");
if (linkedLoop) links.push(path.join(dir, "real", "nested", "loop"));
// A sub-root scan must still follow a link to a sibling directory of the
// workspace; the boundary is the workspace, not the browse root.
const linkedSibling = trySymlink(path.join(dir, "other"), path.join(dir, "real", "link-sibling"), "dir");
if (linkedSibling) links.push(path.join(dir, "real", "link-sibling"));

const svc = new FileService({
	fallbackCwd: () => dir,
	ensureFileIndex: () => {
		throw new Error("unused");
	},
});

afterAll(() => {
	for (const link of links) {
		try {
			fs.unlinkSync(link);
		} catch {
			// Already removed with its parent.
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe.skipIf(!linkedDir || !linkedOutside)("workspace.tree symlinked directories", () => {
	it("keeps the native scan's non-following default", async () => {
		const scan = await listWorkspace({ path: dir, maxDepth: 4, hidden: true, gitignore: false });
		const link = scan.entries.find(entry => entry.path === "link-dir");

		expect(link?.fileType).toBe(FileType.Symlink);
		expect(scan.entries.some(entry => entry.path.startsWith("link-dir/"))).toBe(false);
	});

	it("expands a directory link inside the workspace and marks it", async () => {
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 100, gitignore: false });
		const byPath = new Map(res.entries.map(entry => [entry.path, entry]));
		const link = byPath.get("link-dir");

		expect(link?.isDir).toBe(true);
		expect(link?.isSymlink).toBe(true);
		expect(link?.linkTarget).toContain("real");
		expect(byPath.get("link-dir/nested/child.md")?.isDir).toBe(false);
	});

	it("leaves a directory link outside the workspace as a leaf", async () => {
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 100, gitignore: false });
		const byPath = new Map(res.entries.map(entry => [entry.path, entry]));
		const link = byPath.get("link-out");

		expect(link?.isSymlink).toBe(true);
		expect(link?.isDir).toBe(false);
		expect(link?.linkTarget).toContain(path.basename(outsideDir));
		expect(res.entries.some(entry => entry.path.startsWith("link-out/"))).toBe(false);
	});

	it.skipIf(!linkedFile)("marks file links without presenting them as directories", async () => {
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 100, gitignore: false });
		const link = res.entries.find(entry => entry.path === "child-link.md");

		expect(link?.isSymlink).toBe(true);
		expect(link?.isDir).toBe(false);
	});

	it.skipIf(!linkedLoop)("does not expand a link back to an ancestor", async () => {
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 100, gitignore: false });
		const byPath = new Map(res.entries.map(entry => [entry.path, entry]));

		// Both the primary-scan occurrence and the one seen through `link-dir`.
		for (const linkPath of ["real/nested/loop", "link-dir/nested/loop"]) {
			const link = byPath.get(linkPath);
			expect(link?.isSymlink).toBe(true);
			expect(link?.isDir).toBe(false);
			expect(res.entries.some(entry => entry.path.startsWith(`${linkPath}/`))).toBe(false);
		}
	});

	it("keeps AGENTS.md paths tree-relative inside expanded links", async () => {
		fs.writeFileSync(path.join(dir, "real", "AGENTS.md"), "rules");
		const scan = await listWorkspace({
			path: dir,
			maxDepth: 4,
			hidden: true,
			gitignore: false,
			collectAgentsMd: true,
			followDirSymlinks: true,
			symlinkBoundary: dir,
		});

		// The expanded target lives outside the scan root, so the AGENTS.md path
		// must come from its tree position rather than from stripping the root.
		expect(scan.entries.map(entry => entry.path)).toContain("link-dir/AGENTS.md");
		expect(scan.agentsMdFiles).toContain("link-dir/AGENTS.md");
		expect(scan.entries.every(entry => !path.isAbsolute(entry.path))).toBe(true);
	});

	it.skipIf(!linkedSibling)("bounds a sub-root scan by the workspace, not the browse root", async () => {
		const res = await svc.tree({
			cwd: dir,
			maxDepth: 4,
			perDirLimit: 100,
			gitignore: false,
			root: "real",
		});
		const byPath = new Map(res.entries.map(entry => [entry.path, entry]));

		expect(byPath.get("real/link-sibling")?.isDir).toBe(true);
		expect(byPath.get("real/link-sibling/sibling.md")?.isDir).toBe(false);
	});
});
