#!/usr/bin/env bun
/**
 * Gate: every `"<pkg>": "catalog:"` reference must name a package the
 * workspace catalog actually declares.
 *
 * Why a gate: a dangling catalog reference resolves locally and fails only
 * where the manifest is read from scratch. On CI that is `bun install`, so the
 * failure reads as "cannot resolve catalog version for @x/y" during an install
 * step — a long way from the one-character manifest edit that caused it, and it
 * takes down every job in the run rather than one test.
 *
 * It is invisible locally for the same reason: an already-populated
 * `node_modules` never consults the catalog again, so the wrong reference keeps
 * working on the machine that wrote it and only bites the next clean install.
 *
 * Scans every workspace manifest against the root catalog, and names the
 * package and every manifest that references it, so the fix is one edit rather
 * than a hunt.
 *
 * `CATALOG_REFS_ROOT` points the gate at a different workspace root, which is
 * how its own test runs it against a fixture instead of this repository.
 *
 *   bun scripts/check-catalog-refs.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const CATALOG_PROTOCOL = "catalog:";

interface CatalogRef {
	/** Package name, as written in the manifest. */
	readonly name: string;
	/** Manifest that referenced it, relative to the repo root. */
	readonly manifests: string[];
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		// Malformed JSON is `check-json-validity`'s job, not this gate's.
		return null;
	}
}

function catalogNames(root: Record<string, unknown>): Set<string> {
	const workspaces = root.workspaces;
	if (workspaces === null || typeof workspaces !== "object") return new Set();
	const catalog = (workspaces as { catalog?: unknown }).catalog;
	if (catalog === null || typeof catalog !== "object") return new Set();
	return new Set(Object.keys(catalog as Record<string, unknown>));
}

/**
 * Whether a catalog is declared at all — as opposed to declared and empty.
 *
 * The distinction decides whether the gate runs. A repo with no catalog has
 * nothing to resolve against and needs no gate; a repo whose catalog is empty
 * and whose manifests say `catalog:` has a dangling reference in every one of
 * them, and that is exactly the state worth failing on.
 */
function hasCatalog(root: Record<string, unknown>): boolean {
	const workspaces = root.workspaces;
	if (workspaces === null || typeof workspaces !== "object") return false;
	return typeof (workspaces as { catalog?: unknown }).catalog === "object";
}

/** Every `"name": "catalog:"` pair in one manifest's dependency blocks. */
function catalogRefsIn(manifest: Record<string, unknown>): string[] {
	const found: string[] = [];
	for (const block of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
		const deps = manifest[block];
		if (deps === null || typeof deps !== "object") continue;
		for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
			if (spec === CATALOG_PROTOCOL) found.push(name);
		}
	}
	return found;
}

const REPO_ROOT = process.env.CATALOG_REFS_ROOT ?? path.resolve(import.meta.dir, "..");
const root = readJson(path.join(REPO_ROOT, "package.json"));
if (root === null) {
	console.error("check-catalog-refs: root package.json is unreadable");
	process.exit(1);
}

const catalog = catalogNames(root);
if (!hasCatalog(root)) {
	// No catalog key at all: a repo that never adopted the protocol. Exit before
	// looking for references — there is nothing they could resolve against.
	console.log("check-catalog-refs: OK — no workspace catalog declared");
	process.exit(0);
}

const packagesDir = path.join(REPO_ROOT, "packages");
const refs = new Map<string, CatalogRef>();
for (const entry of fs.existsSync(packagesDir) ? fs.readdirSync(packagesDir, { withFileTypes: true }) : []) {
	if (!entry.isDirectory()) continue;
	const relative = `packages/${entry.name}/package.json`;
	const manifest = readJson(path.join(packagesDir, entry.name, "package.json"));
	if (manifest === null) continue;
	for (const name of catalogRefsIn(manifest)) {
		const existing = refs.get(name);
		if (existing) existing.manifests.push(relative);
		else refs.set(name, { name, manifests: [relative] });
	}
}

const dangling = [...refs.values()].filter(ref => !catalog.has(ref.name)).sort((a, b) => a.name.localeCompare(b.name));

if (dangling.length === 0) {
	console.log(`check-catalog-refs: OK — ${refs.size} catalog reference(s) all declared`);
	process.exit(0);
}

console.error(`check-catalog-refs: ${dangling.length} reference(s) name a package the catalog does not declare:`);
for (const ref of dangling) {
	console.error(`  ${ref.name} — referenced by ${ref.manifests.join(", ")}`);
	console.error(
		`    fix: add "${ref.name}" to workspaces.catalog in the root package.json, or replace "catalog:" with a version`,
	);
}
process.exit(1);
