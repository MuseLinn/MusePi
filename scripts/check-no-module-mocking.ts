/**
 * Ban `mock.module()` in the test tree.
 *
 * Why: Bun's `mock.module` replaces an entry in the global module registry, and
 * that registry is shared by every file in a run. A file that swaps a module
 * changes what a later, unrelated file sees when it imports the same path, which
 * is oven-sh/bun#12823. The symptom is a test that passes alone and fails — or
 * silently stops asserting anything — as soon as the suite grows a file.
 *
 * The repository rule already existed as prose in AGENTS.md and was already
 * broken by one test, which is the argument for a gate rather than more prose: a
 * rule nobody can run is a rule that decays.
 *
 * The replacement is the pattern already used elsewhere in this repository:
 * namespace-import the module and `vi.spyOn` the export, then
 * `vi.restoreAllMocks()` in `afterEach`. That scopes the substitution to the
 * test that asked for it, and it is type-checked — a module factory passed to
 * `mock.module` is not, which is how a stub drifted out of sync with the real
 * signature without anything noticing.
 *
 *   bun scripts/check-no-module-mocking.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

export interface ModuleMockingHit {
	/** Repo-relative path. */
	file: string;
	/** 1-based line of the call. */
	line: number;
}

/**
 * Blank out comments and string bodies while preserving line structure.
 *
 * Both are stripped before the search rather than filtered per line. A
 * multi-line doc comment is the most natural place to explain why this API is
 * banned, and a test that documents the ban has to spell the call out as a
 * string — so the gate's own text, its contract cases and the AGENTS.md rule
 * would all be reported as violations otherwise. Newlines survive so the
 * reported line numbers still point at the real call site.
 *
 * The blind spot this creates is a call assembled at runtime from string
 * fragments, which no static gate could see anyway.
 */
export function stripNonCode(source: string): string {
	let out = "";
	let i = 0;
	let inLine = false;
	let inBlock = false;
	let quote: string | null = null;
	while (i < source.length) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (inLine) {
			out += ch === "\n" ? "\n" : " ";
			if (ch === "\n") inLine = false;
			i++;
			continue;
		}
		if (inBlock) {
			if (ch === "*" && next === "/") {
				out += "  ";
				i += 2;
				inBlock = false;
				continue;
			}
			out += ch === "\n" ? "\n" : " ";
			i++;
			continue;
		}
		if (quote) {
			if (ch === "\\") {
				out += "  ";
				i += 2;
				continue;
			}
			if (ch === quote) {
				quote = null;
				out += ch;
			} else {
				out += ch === "\n" ? "\n" : " ";
			}
			i++;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			out += "  ";
			i += 2;
			inLine = true;
			continue;
		}
		if (ch === "/" && next === "*") {
			out += "  ";
			i += 2;
			inBlock = true;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** `mock.module(` — tolerant of whitespace, and not a longer member name. */
const CALL = /(^|[^\w$.])mock\s*\.\s*module\s*\(/;

export function findModuleMocking(file: string, source: string): ModuleMockingHit[] {
	const hits: ModuleMockingHit[] = [];
	stripNonCode(source)
		.split("\n")
		.forEach((text, index) => {
			if (CALL.test(text)) hits.push({ file, line: index + 1 });
		});
	return hits;
}

async function main(): Promise<void> {
	const listed = await $`git ls-files ${"*.ts"} ${"*.tsx"}`.quiet().nothrow();
	if (listed.exitCode !== 0) throw new Error("git ls-files failed");
	const files = listed
		.text()
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);

	const hits: ModuleMockingHit[] = [];
	for (const file of files) {
		if (!/\.(test|spec)\.tsx?$/.test(file)) continue;
		const source = await fs.promises.readFile(path.resolve(file), "utf8");
		hits.push(...findModuleMocking(file, source));
	}

	if (hits.length > 0) {
		for (const h of hits) console.error(`  ${h.file}:${h.line}: mock.module()`);
		console.error(
			"\nno-module-mocking: mock.module() rewrites the global module registry, which" +
				"\nleaks into every later file in the run (oven-sh/bun#12823). Namespace-import the" +
				"\nmodule and vi.spyOn the export instead, restoring in afterEach.",
		);
		process.exit(1);
	}
	console.log("no-module-mocking: OK — no mock.module() in the test tree");
}

if (import.meta.main) await main();
