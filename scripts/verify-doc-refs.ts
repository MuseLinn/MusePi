import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Glob } from "bun";

/**
 * Gate: a documentation path cited from repo-authored source must exist.
 *
 * Why a gate: a source comment that points at `docs/foo.md` <!-- doc-reference-example: shape only --> reads as authoritative
 * navigation, so a moved or deleted document leaves the code claiming a home it
 * no longer has. Nothing else in the toolchain resolves these citations.
 *
 * The scan is textual: it reads source text
 * rather than a syntax tree because a citation may appear in a line comment, a
 * JSDoc block, or a string literal, and all three are equally binding on a
 * maintainer. Built output and vendored upstream source are excluded — their
 * paths belong to the generator or to the upstream project.
 */

const ROOT = resolve(import.meta.dirname, "..");

/** Repo-authored source that may cite documents. */
const SOURCE_GLOBS = [
	"packages/**/*.ts",
	"packages/**/*.tsx",
	"scripts/**/*.ts",
	"apps/**/*.ts",
	"apps/**/*.tsx",
] as const;

/**
 * A root-relative documentation citation: a path under `docs/` or
 * `.agents/notes/` ending in `.md`. The extension is required so a directory
 * mention or a bare `docs/` in prose does not count, and a leading URL segment
 * (`https://host/docs/…`) does not count because a citation starts at a path
 * boundary rather than inside a URL.
 */
const DOC_REFERENCE = /(?<![/\w:])(?:\bdocs|\.agents\/notes)\/[A-Za-z0-9._/-]+\.md/g;

/**
 * A citation on a line carrying this marker is illustrative: it names the shape
 * of a citation, not a document that exists. The marker counts on the citing
 * line or the line directly above it.
 */
const EXAMPLE_MARKER = "doc-reference-example:";

/** Built output, declaration files, tests, and vendored upstream source are not ours. */
export function isExcludedSource(path: string): boolean {
	const normalized = path.split("\\").join("/");
	if (normalized.startsWith("vendor/") || normalized.includes("/node_modules/")) return true;
	if (normalized.includes("/lib/") || normalized.includes("/dist/")) return true;
	// A test fixture names synthetic documents to exercise a renderer; its paths
	// describe no real file and would be wrong to resolve.
	if (normalized.includes("/test/") || normalized.includes("/tests/") || /\.(?:test|spec)\.tsx?$/.test(normalized)) {
		return true;
	}
	return normalized.endsWith(".d.ts");
}

/** One citation whose target does not exist. */
interface DocReferenceViolation {
	/** Repository-relative citing file. */
	file: string;
	/** One-based line of the citation. */
	line: number;
	/** The cited path, exactly as written. */
	reference: string;
}

/**
 * Find every broken documentation citation in one file's text.
 *
 * `exists` is injected so a caller shares one probe cache across the run and so
 * this is testable without a filesystem.
 */
export function findReferenceViolations(
	file: string,
	source: string,
	exists: (repoPath: string) => boolean,
): DocReferenceViolation[] {
	const violations: DocReferenceViolation[] = [];
	const seen = new Set<string>();
	const starts = [0];
	for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
	const lineOf = (offset: number): number => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if ((starts[mid] ?? 0) <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
	for (const match of source.matchAll(DOC_REFERENCE)) {
		const reference = match[0].replace(/[.,;:]+$/, "");
		if (exists(reference)) continue;
		const offset = match.index ?? 0;
		const line = lineOf(offset);
		if (isExampleCitation(source, line)) continue;
		const key = `${line}:${reference}`;
		if (seen.has(key)) continue;
		seen.add(key);
		violations.push({ file, line, reference });
	}
	return violations;
}

/** Whether one line's citation is illustrative rather than a real reference. */
export function isExampleCitation(source: string, line: number): boolean {
	const lines = source.split("\n");
	return (lines[line - 1] ?? "").includes(EXAMPLE_MARKER) || (lines[line - 2] ?? "").includes(EXAMPLE_MARKER);
}

/** Repo-authored sources whose citations are checked. */
export async function sourceFiles(scanRoot: string = ROOT): Promise<string[]> {
	const files = new Set<string>();
	for (const pattern of SOURCE_GLOBS) {
		for await (const rel of new Glob(pattern).scan(scanRoot)) {
			const normalized = rel.split("\\").join("/");
			if (isExcludedSource(normalized)) continue;
			files.add(resolve(scanRoot, normalized));
		}
	}
	return [...files].sort();
}

async function main(): Promise<number> {
	const files = await sourceFiles();
	const probes = new Map<string, boolean>();
	const exists = (repoPath: string): boolean => {
		const hit = probes.get(repoPath);
		if (hit !== undefined) return hit;
		const probe = Bun.file(resolve(ROOT, repoPath)).size > 0;
		probes.set(repoPath, probe);
		return probe;
	};
	const violations = files.flatMap(absPath =>
		findReferenceViolations(relative(ROOT, absPath).split("\\").join("/"), readFileSync(absPath, "utf8"), exists),
	);
	if (violations.length === 0) {
		console.log(`verify-doc-refs: ${files.length} file(s) checked, all documentation citations resolve.`);
		return 0;
	}
	console.error("verify-doc-refs: broken documentation citations in source (target does not exist):");
	for (const violation of violations) {
		console.error(`  ${violation.file}:${violation.line}  ${violation.reference}`);
	}
	return 1;
}

if (import.meta.main) process.exit(await main());
