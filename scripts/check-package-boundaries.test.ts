import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractSpecifiers } from "./check-package-boundaries";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

interface WorkspaceSpec {
	packages?: Record<string, { name: string; deps?: string[] }>;
	apps?: Record<string, { name: string; deps?: string[] }>;
}

/** A minimal workspace with the same one-directory-per-package layout as the real one. */
function workspace(spec: WorkspaceSpec): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-boundaries-"));
	dirs.push(root);
	for (const [group, entries] of Object.entries(spec)) {
		for (const [dir, pkg] of Object.entries(entries ?? {})) {
			const dependencies = Object.fromEntries((pkg.deps ?? []).map(name => [name, "workspace:*"]));
			writeJson(path.join(root, group, dir, "package.json"), { name: pkg.name, dependencies });
		}
	}
	return root;
}

function runGate(root: string): { code: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ["bun", path.join(REPO_ROOT, "scripts", "check-package-boundaries.ts")],
		cwd: root,
		env: { ...process.env, PACKAGE_BOUNDARY_ROOT: root },
	});
	return {
		code: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("check-package-boundaries", () => {
	test("ignores import statements quoted inside fixture strings", () => {
		const source = "const fixture = 'import { t } from \"@x/y\";';\nconst deep = \"import('@x/z')\";";
		expect(extractSpecifiers(source)).toEqual([]);
	});

	test("reads multi-line imports and dynamic imports", () => {
		const source = [
			"import {",
			"	a,",
			'} from "@x/y";',
			'const lazy = await import("@x/z");',
			'import "@x/side-effect";',
		].join("\n");
		expect(extractSpecifiers(source).sort()).toEqual(["@x/side-effect", "@x/y", "@x/z"]);
	});

	test("passes when a declared workspace dependency is imported by name", () => {
		const root = workspace({
			packages: { a: { name: "@x/a", deps: ["@x/b"] }, b: { name: "@x/b" } },
		});
		writeFile(path.join(root, "packages/a/src/index.ts"), 'import { b } from "@x/b";');
		const result = runGate(root);
		expect(result.code).toBe(0);
	});

	test("fails on an undeclared workspace import and names both packages", () => {
		const root = workspace({ packages: { a: { name: "@x/a" }, b: { name: "@x/b" } } });
		writeFile(path.join(root, "packages/b/src/index.ts"), 'import { a } from "@x/a";');
		const result = runGate(root);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("@x/b does not declare @x/a");
	});

	test("accepts a subpath of a declared workspace package", () => {
		const root = workspace({
			packages: { a: { name: "@x/a", deps: ["@x/b"] }, b: { name: "@x/b" } },
		});
		writeFile(path.join(root, "packages/a/src/index.ts"), 'import { x } from "@x/b/extra";');
		expect(runGate(root).code).toBe(0);
	});

	test("accepts relative imports inside the package", () => {
		const root = workspace({ packages: { a: { name: "@x/a" } } });
		writeFile(path.join(root, "packages/a/src/index.ts"), 'import { local } from "./local";');
		expect(runGate(root).code).toBe(0);
	});

	test("fails when shipped code reaches another package through a relative path", () => {
		const root = workspace({ packages: { a: { name: "@x/a" }, b: { name: "@x/b" } } });
		writeFile(path.join(root, "packages/a/src/index.ts"), 'import { b } from "../../b/src/index";');
		const result = runGate(root);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("relative-escape");
	});

	test("allows tests to reach a sibling package internals that have no export", () => {
		const root = workspace({ packages: { a: { name: "@x/a" }, b: { name: "@x/b" } } });
		writeFile(path.join(root, "packages/a/test/uses-b.test.ts"), 'import { b } from "../../b/src/index";');
		expect(runGate(root).code).toBe(0);
	});

	test("fails when a library package depends on an app", () => {
		const root = workspace({
			packages: { a: { name: "@x/a", deps: ["@x/app"] } },
			apps: { app: { name: "@x/app" } },
		});
		writeFile(path.join(root, "packages/a/src/index.ts"), 'import { app } from "@x/app";');
		const result = runGate(root);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("reverse-layer");
	});

	test("records existing violations in the baseline and blocks growth", () => {
		const root = workspace({ packages: { a: { name: "@x/a" }, b: { name: "@x/b" } } });
		const file = path.join(root, "packages/b/src/index.ts");
		writeFile(file, 'import { a } from "@x/a";');
		writeJson(path.join(root, "scripts/package-boundaries-baseline.json"), {
			"undeclared-workspace-import": { "packages/b/src/index.ts": 1 },
		});
		expect(runGate(root).code).toBe(0);

		writeFile(file, 'import { a } from "@x/a"; import { a2 } from "@x/a/sub";');
		const result = runGate(root);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("undeclared-workspace-import");
	});
});
