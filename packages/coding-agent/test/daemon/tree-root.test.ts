import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileService } from "../../src/daemon/services/file-service";

/**
 * `workspace.tree`'s `root` narrows the scan to a directory inside the workspace
 * (M1.12's tab-add target picker: picking a directory makes it the tab's browse
 * root rather than the whole tree).
 *
 * Two contracts matter here and both are about the path rule rather than the
 * scan:
 *
 * Entries stay **relative to cwd**, prefix included. The renderer keeps one path
 * rule for previews, external reveals and the artifact lookup; a second rule for
 * sub-rooted trees would be a second place for them to disagree.
 *
 * A root that leaves the workspace returns an empty tree instead of scanning it.
 * The picker hands this parameter a path from a native dialog, which is a
 * boundary the renderer cannot be trusted to enforce alone.
 */
let dir: string;
let svc: FileService;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-root-test-"));
	fs.mkdirSync(path.join(dir, "sub", "nested"), { recursive: true });
	fs.mkdirSync(path.join(dir, "other"), { recursive: true });
	fs.writeFileSync(path.join(dir, "top.md"), "top");
	fs.writeFileSync(path.join(dir, "sub", "inner.md"), "inner");
	fs.writeFileSync(path.join(dir, "sub", "nested", "deep.md"), "deep");
	fs.writeFileSync(path.join(dir, "other", "elsewhere.md"), "elsewhere");
	svc = new FileService({
		fallbackCwd: () => dir,
		ensureFileIndex: () => {
			throw new Error("unused");
		},
	});
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace.tree root", () => {
	it("scans the whole workspace when no root is given", async () => {
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 50, gitignore: false });
		const paths = res.entries.map(e => e.path);
		expect(paths).toContain("top.md");
		expect(paths).toContain("sub/inner.md");
	});

	it("scans from a sub-root and re-roots entries onto cwd", async () => {
		// The point of the parameter: narrower content, unchanged path rule.
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 50, gitignore: false, root: "sub" });
		const paths = res.entries.map(e => e.path);

		expect(paths).toContain("sub/inner.md");
		expect(paths).toContain("sub/nested/deep.md");
		// Nothing outside the picked directory leaks in.
		expect(paths).not.toContain("top.md");
		expect(paths).not.toContain("other/elsewhere.md");
	});

	it("reports rootPath as the workspace, not the sub-root", async () => {
		// Consumers resolve `rootPath` against absolute paths; a sub-root here
		// would silently mis-prefix every entry.
		const res = await svc.tree({ cwd: dir, maxDepth: 1, perDirLimit: 50, gitignore: false, root: "sub" });
		expect(res.rootPath).toBe(path.resolve(dir));
	});

	it("returns an empty tree for a root outside the workspace", async () => {
		// The picker passes whatever a native dialog returned; the escape check
		// lives here, not in the renderer.
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 50, gitignore: false, root: ".." });
		expect(res.entries).toEqual([]);
		expect(res.truncated).toBe(false);
	});

	it("treats an absolute-looking root as relative to cwd", async () => {
		// `/etc` is a cwd-relative path here, so it scans for a directory of that
		// name under the workspace rather than at the filesystem root.
		const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 50, gitignore: false, root: "/etc" });
		expect(res.entries.every(e => !e.path.includes("passwd"))).toBe(true);
	});

	it("treats an empty or dot root as the whole workspace", async () => {
		for (const root of ["", ".", "  "]) {
			const res = await svc.tree({ cwd: dir, maxDepth: 4, perDirLimit: 50, gitignore: false, root });
			expect(res.entries.map(e => e.path)).toContain("top.md");
		}
	});
});
