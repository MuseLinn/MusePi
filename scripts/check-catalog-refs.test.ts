/**
 * The catalog gate names the package, every manifest referencing it, and the
 * two ways to fix it — so the failure points at the edit rather than at the
 * install step that trips over it later.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

function runGate(root: string): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ["bun", path.join(REPO_ROOT, "scripts", "check-catalog-refs.ts")],
		cwd: root,
		env: { ...process.env, CATALOG_REFS_ROOT: root },
	});
	return {
		code: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

/** A minimal workspace shaped like the real one, so the gate has something to read. */
function writeWorkspace(catalog: Record<string, string>, refs: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-refs-"));
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name: "root", workspaces: { packages: ["packages/*"], catalog } }),
	);
	const pkg = path.join(dir, "packages", "one");
	fs.mkdirSync(pkg, { recursive: true });
	fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "one", dependencies: refs }));
	return dir;
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("check-catalog-refs", () => {
	test("passes when every catalog reference is declared", () => {
		const dir = writeWorkspace({ alpha: "^1.0.0" }, { alpha: "catalog:" });
		dirs.push(dir);
		expect(runGate(dir).code).toBe(0);
	});

	test("fails and names the package when a reference is not declared", () => {
		const dir = writeWorkspace({ alpha: "^1.0.0" }, { beta: "catalog:" });
		dirs.push(dir);
		const result = runGate(dir);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("beta");
	});

	test("names the manifest, so the fix is one edit rather than a hunt", () => {
		const dir = writeWorkspace({}, { gamma: "catalog:" });
		dirs.push(dir);
		expect(runGate(dir).stderr).toContain("packages/one/package.json");
	});

	test("offers both repairs rather than only the one it prefers", () => {
		// Either fix is legitimate: declare the package, or stop referring to the
		// catalog. Naming only one would push the next person toward it without
		// telling them the other exists.
		const dir = writeWorkspace({}, { delta: "catalog:" });
		dirs.push(dir);
		const stderr = runGate(dir).stderr;
		expect(stderr).toContain("workspaces.catalog");
		expect(stderr).toContain("replace");
	});

	test("does not flag dependencies that carry a version", () => {
		// The gate is about the catalog protocol, not about pinning: a package
		// with a literal range is doing something deliberate.
		const dir = writeWorkspace({ alpha: "^1.0.0" }, { alpha: "catalog:", epsilon: "^2.0.0" });
		dirs.push(dir);
		expect(runGate(dir).code).toBe(0);
	});

	test("passes on a workspace with no catalog at all", () => {
		// A repo that never adopted the protocol must not be forced to declare one
		// just to satisfy the gate.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-refs-"));
		dirs.push(dir);
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "root", workspaces: { packages: [] } }));
		expect(runGate(dir).code).toBe(0);
	});
});
