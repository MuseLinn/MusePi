#!/usr/bin/env bun

/**
 * Generate the capability-seams index table.
 *
 * Why generate the table: the anchor paths change whenever a package or a
 * directory is moved, and a hand-edited table drifts silently. Each row keeps
 * its owning package and the generator resolves the anchor, so a rename moves
 * one package entry instead of twenty document edits.
 *
 * Only the table is derived. The rows' prose — what each seam is, where it
 * declares itself — is authored in `gen-capability-seams-data.ts`; the parser
 * turns that prose's backticked paths into `{ pkg, path }` anchors so the
 * generated table points at the owner, not at a path that moves.
 *
 * The completeness guard rejects a provider that publishes a service but never
 * appears in the index, so adding a `provide` cannot leave the index blind.
 *
 * Output is committed and freshness-gated by `verify-generated.ts`.
 *
 * usage: bun run gen:capability-seams
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import type { SeamAnchor, SeamCell } from "./gen-capability-seams-data";
import { SEAM_ROWS } from "./gen-capability-seams-data";

const ROOT = join(import.meta.dir, "..");
const OUTPUT = "docs/capability-seams.md";

/** Where the generated table lives, and the markers that bound it. */
const REGION_SLUG = "capability-seams";
const BEGIN = `<!-- BEGIN GENERATED ${REGION_SLUG} -->`;
const END = `<!-- END GENERATED ${REGION_SLUG} -->`;

interface PackageEntry {
	readonly dir: string;
	readonly name: string;
	readonly manifest: Record<string, unknown>;
}

/** Manifests whose package may be referenced as an anchor owner. */
const PACKAGE_GLOBS = [
	"packages/*/package.json",
	"apps/*/package.json",
	"packages/*/*/package.json",
	"packages/coding-agent/src/plugins/*/*/package.json",
	"apps/desktop/src/plugins/*/package.json",
] as const;

async function loadPackages(): Promise<PackageEntry[]> {
	const packages: PackageEntry[] = [];
	for (const pattern of PACKAGE_GLOBS) {
		for await (const rel of new Glob(pattern).scan(ROOT)) {
			const normalized = rel.split("\\").join("/");
			if (normalized.includes("/node_modules/")) continue;
			let manifest: Record<string, unknown>;
			try {
				manifest = JSON.parse(await Bun.file(join(ROOT, normalized)).text());
			} catch {
				continue;
			}
			const name = manifest.name;
			if (typeof name !== "string" || name.length === 0) continue;
			packages.push({
				dir: normalized.slice(0, normalized.length - "package.json".length).replace(/\/$/, ""),
				name,
				manifest,
			});
		}
	}
	return packages;
}

/** Service keys a plugin publishes, read from its Cordis entry's `provide`. */
async function providedKeys(entry: string): Promise<string[]> {
	const file = Bun.file(resolve(ROOT, entry));
	if (!(await file.exists())) return [];
	const source = await file.text();
	// `export const provide = ["a", "b"] as const`
	return (
		source
			.match(/export const provide\s*=\s*\[([^\]]*)\]/)?.[1]
			?.split(",")
			.map(raw => raw.trim().replace(/^"|"$/g, ""))
			.filter(raw => raw.length > 0) ?? []
	);
}

/** True when the plugin declares a non-empty `musepi.extensions` list. */
function isPluginPackage(entry: PackageEntry): boolean {
	const musepi = entry.manifest.musepi;
	if (typeof musepi !== "object" || musepi === null) return false;
	const extensions = (musepi as Record<string, unknown>).extensions;
	return Array.isArray(extensions) && extensions.length > 0;
}

/**
 * The completeness guard.
 *
 * Two invariants, both mechanically decidable:
 * 1. Every anchor still resolves to a file, so a moved package cannot leave a
 *    dead path in the table.
 * 2. Every service key a plugin publishes appears in the rendered table. A
 *    plugin that starts providing a new service must be indexed; a package that
 *    is already indexed does not exempt its new keys.
 */
async function assertComplete(packages: PackageEntry[], anchors: readonly SeamAnchor[], region: string): void {
	const byName = new Map(packages.map(p => [p.name, p]));
	const errors: string[] = [];

	for (const entry of packages) {
		const musepi = entry.manifest.musepi;
		if (typeof musepi !== "object" || musepi === null) continue;
		const declared = (musepi as Record<string, unknown>).extensions;
		if (!Array.isArray(declared) || declared.length === 0) continue;
		for (const rel of declared) {
			if (typeof rel !== "string") continue;
			for (const key of await providedKeys(join(entry.dir, rel))) {
				// A published service is indexed when the table names it.
				if (!region.includes(`\`${key}\``) && !region.includes(`"${key}"`)) {
					errors.push(`${entry.name} publishes service "${key}" that the index never names (${rel})`);
				}
			}
		}
	}

	for (const anchor of anchors) {
		const entry = byName.get(anchor.pkg);
		if (entry === undefined) {
			errors.push(`anchor names a package that is not in the workspace index: ${anchor.pkg}`);
			continue;
		}
		if (anchor.path.length > 0 && !existsSync(resolve(ROOT, entry.dir, anchor.path))) {
			errors.push(`anchor path no longer exists: ${anchor.pkg}@${anchor.path}`);
		}
	}

	if (errors.length > 0) {
		throw new Error(`capability-seams completeness guard failed:\n  ${errors.join("\n  ")}`);
	}
}

/** Render one cell, escaping the pipe that would break the Markdown table. */
function renderCell(cells: readonly SeamCell[], packages: PackageEntry[]): string {
	const byName = new Map(packages.map(p => [p.name, p]));
	const parts: string[] = [];
	for (const cell of cells) {
		if (typeof cell !== "string") {
			const entry = byName.get(cell.pkg);
			if (entry === undefined) {
				throw new Error(`anchor names an unknown package: ${cell.pkg}`);
			}
			const target = cell.path.length > 0 ? `${entry.dir}/${cell.path}` : entry.dir;
			parts.push(`\`${target}\``);
		} else {
			parts.push(cell);
		}
	}
	return parts.join("").replaceAll("|", "\\|");
}

function renderTable(packages: PackageEntry[]): string {
	const rows = SEAM_ROWS.map(row => {
		return `| ${renderCell([row.domain], packages)} | ${renderCell(row.anchor, packages)} | ${renderCell(row.declaration, packages)} |`;
	});
	return ["| 域 | 权威锚点 | 声明位置 |", "|---|---|---|", ...rows].join("\n");
}

/** Splice the generated region back into the document, keeping its own prose. */
function splice(content: string, region: string): string {
	const beginAt = content.indexOf(BEGIN);
	const endAt = content.indexOf(END);
	if (beginAt < 0 || endAt < 0) {
		throw new Error(`docs/capability-seams.md must contain both \`${BEGIN}\` and \`${END}\` markers`);
	}
	if (content.indexOf(BEGIN, beginAt + 1) >= 0) {
		throw new Error(`expected exactly one BEGIN marker, found more than one`);
	}
	const body = content.slice(beginAt + BEGIN.length, endAt);
	return `${content.slice(0, beginAt + BEGIN.length)}\n${region}\n${content.slice(endAt)}`;
}

/** Preserve the document's own prose: the intro and the context-ownership note. */
const PROSE_HEADER = `<!-- The table below is generated by scripts/gen-capability-seams.ts - do not edit it by hand.
     Run \`bun run gen:capability-seams\` to regenerate; \`verify-generated\` fails on drift. -->

`;

async function build(existing: string): Promise<string> {
	const packages = await loadPackages();
	const anchors: SeamAnchor[] = [];
	for (const row of SEAM_ROWS) {
		for (const cell of row.anchor) {
			if (typeof cell !== "string") anchors.push(cell);
		}
	}
	const table = renderTable(packages);
	await assertComplete(packages, anchors, table);
	const region = `${PROSE_HEADER}${table}`;
	if (!existing.includes(BEGIN)) return `${existing.trimEnd()}\n\n${region}\n\n${END}\n`;
	return splice(existing, region);
}

export async function buildCapabilitySeams(): Promise<string> {
	const existing = Bun.file(join(ROOT, OUTPUT)).exists() ? await Bun.file(join(ROOT, OUTPUT)).text() : "";
	return build(existing);
}

if (import.meta.main) {
	const existing = await Bun.file(join(ROOT, OUTPUT)).text();
	const text = await build(existing);
	writeFileSync(join(ROOT, OUTPUT), text);
	const rows = SEAM_ROWS.length;
	console.log(`capability seams: ${OUTPUT} (${rows} row(s))`);
}
