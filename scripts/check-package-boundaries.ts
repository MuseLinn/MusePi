#!/usr/bin/env bun

/**
 * Gate: workspace packages may only reach each other through declared package
 * names, and library packages may not depend on app or tool surfaces.
 *
 * Why a gate: an undeclared import still resolves locally through workspace
 * symlinks, so it only fails in a clean install or a published tarball — the
 * same failure mode `check-catalog-refs` exists to prevent. A relative path
 * that climbs out of the package survives every install and silently welds two
 * packages together; nothing else in the pipeline notices.
 *
 * Existing relative escapes are recorded in
 * `scripts/package-boundaries-baseline.json` per file, so the tree can be
 * cleaned incrementally and only a new violation fails.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const DEFAULT_ROOT = join(import.meta.dir, "..");
const WORKSPACE_DIRS = ["packages", "apps", "tools"];
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|jsx)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "target", ".next", ".turbo", "vendor", ".git"]);
/**
 * Minified bundles are single-line files where a specifier regex costs more
 * than the answer is worth; the generated artifacts they contain are covered by
 * `verify-generated.ts` instead.
 */
const MAX_SCAN_BYTES = 1024 * 1024;

/** A workspace package and the dependencies its manifest declares. */
export interface WorkspacePackage {
	/** Package name as imported by consumers, e.g. `@musepi/pi-ai`. */
	name: string;
	/** Repository-relative directory with forward slashes. */
	dir: string;
	/** Every declared dependency name, across all dependency sections. */
	deps: ReadonlySet<string>;
}

/** One import that the boundary rules reject. */
export interface BoundaryViolation {
	/** Which rule rejected the import. */
	rule: "undeclared-workspace-import" | "relative-escape" | "reverse-layer";
	/** Repository-relative source file. */
	file: string;
	/** The offending specifier as written. */
	specifier: string;
	/** Extra context for the failure message (target package, package dir). */
	detail: string;
}

/** Baseline counts keyed by rule, then repository-relative file. */
export type BoundaryBaseline = Record<string, Record<string, number>>;

function toPosix(value: string): string {
	return value.split(sep).join("/");
}

function* walkSources(dir: string): Generator<string> {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (SKIP_DIRS.has(name)) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			yield* walkSources(path);
		} else if (SOURCE_FILE.test(name) && !name.endsWith(".map")) {
			yield path;
		}
	}
}

/** Whether `index` on `line` sits inside a single-, double-, or backtick-quoted string. */
function isInsideStringAt(line: string, index: number): boolean {
	let quote: string | null = null;
	for (let i = 0; i < index; i++) {
		const char = line[i];
		if (quote) {
			if (char === "\\") i++;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") quote = char;
	}
	return quote !== null;
}

/**
 * Extract every static import specifier from a source file.
 *
 * Line-oriented on purpose: a specifier regex over the whole file also matches
 * fixture strings such as `'import { t } from "@x/y";'`, which are data, not
 * dependencies. Only a line that opens an import/export statement, continues
 * one, or calls `import()`/`require()` outside a string is read.
 */
export function extractSpecifiers(source: string): string[] {
	const specifiers = new Set<string>();
	let inStatement = false;
	for (const raw of source.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		const startsStatement = /^(?:import|export)\b/.test(line);
		if (startsStatement || inStatement) {
			const fromMatches = [...line.matchAll(/\bfrom\s*["']([^"']+)["']/g)];
			if (fromMatches.length > 0) {
				for (const match of fromMatches) specifiers.add(match[1]);
				inStatement = false;
				continue;
			}
			const sideEffect = line.match(/^import\s*["']([^"']+)["']/);
			if (sideEffect) {
				specifiers.add(sideEffect[1]);
				inStatement = false;
				continue;
			}
			inStatement = !line.endsWith(";");
			continue;
		}
		const dynamic = line.match(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/);
		if (dynamic && !isInsideStringAt(line, dynamic.index ?? 0)) specifiers.add(dynamic[1]);
	}
	return [...specifiers];
}

/** Read every workspace manifest under the scanned roots. */
export function readWorkspacePackages(root: string): WorkspacePackage[] {
	const packages: WorkspacePackage[] = [];
	for (const group of WORKSPACE_DIRS) {
		const groupDir = join(root, group);
		if (!existsSync(groupDir)) continue;
		for (const name of readdirSync(groupDir)) {
			const dir = join(groupDir, name);
			const manifest = join(dir, "package.json");
			if (!existsSync(manifest) || !statSync(dir).isDirectory()) continue;
			let parsed: {
				name?: string;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
				peerDependencies?: Record<string, string>;
				optionalDependencies?: Record<string, string>;
			};
			try {
				parsed = JSON.parse(readFileSync(manifest, "utf8"));
			} catch {
				continue;
			}
			if (!parsed.name) continue;
			const deps = new Set([
				...Object.keys(parsed.dependencies ?? {}),
				...Object.keys(parsed.devDependencies ?? {}),
				...Object.keys(parsed.peerDependencies ?? {}),
				...Object.keys(parsed.optionalDependencies ?? {}),
			]);
			packages.push({ name: parsed.name, dir: toPosix(relative(root, dir)), deps });
		}
	}
	return packages;
}

/** Resolve a bare specifier to the workspace package that owns it. */
export function owningPackage(specifier: string, byName: Map<string, WorkspacePackage>): WorkspacePackage | undefined {
	const exact = byName.get(specifier);
	if (exact) return exact;
	const segments = specifier.split("/");
	const scoped = segments.length >= 2 ? `${segments[0]}/${segments[1]}` : specifier;
	return byName.get(scoped);
}

/** Evaluate one import against the three boundary rules. */
export function classifyImport(
	file: string,
	specifier: string,
	owner: WorkspacePackage,
	byName: Map<string, WorkspacePackage>,
	root: string,
): BoundaryViolation | null {
	if (specifier.startsWith(".")) {
		// Tests and scripts may reach a sibling package's internals through a
		// path when no export exists for them; shipped code may not.
		if (!file.startsWith(`${owner.dir}/src/`)) return null;
		const target = resolve(dirname(join(root, file)), specifier);
		const ownerDir = join(root, owner.dir);
		if (target !== ownerDir && !target.startsWith(ownerDir + sep)) {
			return {
				rule: "relative-escape",
				file,
				specifier,
				detail: `escapes ${owner.dir}; import the package by name instead`,
			};
		}
		return null;
	}
	if (specifier.startsWith("node:") || specifier.startsWith("bun:")) return null;

	const target = owningPackage(specifier, byName);
	if (!target) return null;
	if (target.name === owner.name) return null;
	if (!owner.deps.has(target.name)) {
		return {
			rule: "undeclared-workspace-import",
			file,
			specifier,
			detail: `${owner.name} does not declare ${target.name}`,
		};
	}
	if (owner.dir.startsWith("packages/") && !target.dir.startsWith("packages/")) {
		return {
			rule: "reverse-layer",
			file,
			specifier,
			detail: `library package ${owner.name} must not depend on ${target.dir}`,
		};
	}
	return null;
}

/** Collect every violation in the workspace. */
export function findViolations(root: string = DEFAULT_ROOT): BoundaryViolation[] {
	const packages = readWorkspacePackages(root);
	const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
	const violations: BoundaryViolation[] = [];
	for (const pkg of packages) {
		for (const absolute of walkSources(join(root, pkg.dir))) {
			if (statSync(absolute).size > MAX_SCAN_BYTES) continue;
			const file = toPosix(relative(root, absolute));
			const source = readFileSync(absolute, "utf8");
			for (const specifier of extractSpecifiers(source)) {
				const violation = classifyImport(file, specifier, pkg, byName, root);
				if (violation) violations.push(violation);
			}
		}
	}
	return violations;
}

/** Apply the recorded baseline, returning only violations that exceed it. */
export function beyondBaseline(
	violations: BoundaryViolation[],
	baseline: BoundaryBaseline,
): { failing: BoundaryViolation[]; stale: string[] } {
	const actual = new Map<string, number>();
	for (const violation of violations) {
		const key = `${violation.rule}\u0000${violation.file}`;
		actual.set(key, (actual.get(key) ?? 0) + 1);
	}
	const failing: BoundaryViolation[] = [];
	const seen = new Map<string, number>();
	for (const violation of violations) {
		const key = `${violation.rule}\u0000${violation.file}`;
		const allowed = baseline[violation.rule]?.[violation.file] ?? 0;
		const index = seen.get(key) ?? 0;
		seen.set(key, index + 1);
		if (index >= allowed) failing.push(violation);
	}
	const stale: string[] = [];
	for (const [rule, files] of Object.entries(baseline)) {
		for (const [file, count] of Object.entries(files)) {
			const current = actual.get(`${rule}\u0000${file}`) ?? 0;
			if (current < count) stale.push(`${rule} ${file}: baseline ${count}, actual ${current}`);
		}
	}
	return { failing, stale };
}

function loadBaseline(root: string): BoundaryBaseline {
	const path = process.env.PACKAGE_BOUNDARY_BASELINE ?? join(root, "scripts", "package-boundaries-baseline.json");
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, "utf8")) as BoundaryBaseline;
}

function main(): number {
	const root = process.env.PACKAGE_BOUNDARY_ROOT ?? DEFAULT_ROOT;
	const violations = findViolations(root);
	const { failing, stale } = beyondBaseline(violations, loadBaseline(root));

	for (const line of stale) {
		console.warn(`baseline can be lowered: ${line}`);
	}
	if (failing.length === 0) {
		console.log(`package boundaries ok (${violations.length} recorded violations)`);
		return 0;
	}

	console.error("package boundary violations:");
	const byRule = new Map<string, BoundaryViolation[]>();
	for (const violation of failing) {
		byRule.set(violation.rule, [...(byRule.get(violation.rule) ?? []), violation]);
	}
	for (const [rule, items] of byRule) {
		console.error(`\n${rule} (${items.length}):`);
		for (const item of items) console.error(`  ${item.file}: ${item.specifier} — ${item.detail}`);
	}
	console.error("\nDeclare the dependency in package.json, or import the package by name.");
	return 1;
}

if (import.meta.main) process.exit(main());
