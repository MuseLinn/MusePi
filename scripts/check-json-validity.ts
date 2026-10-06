#!/usr/bin/env bun
import { existsSync } from "node:fs";
import path from "node:path";
/**
 * Gate: every `package.json` must be strictly valid JSON.
 *
 * Why a gate: a trailing comma makes the file invalid JSON. Every strict reader
 * rejects it — `bun install`, the release script's version bump, and Nix's
 * `importJSON` (which fails the whole flake evaluation, not just one package).
 * A tolerant reader (PowerShell's `ConvertFrom-Json`, editors with recovery)
 * accepts it silently, so the breakage is invisible locally and only surfaces
 * in CI or at release time. Two such commas shipped in the same commit before
 * this gate existed.
 *
 * Only manifests are checked: they are the files every toolchain reads
 * unconditionally, and they are the ones a version bump rewrites.
 *
 *   bun scripts/check-json-validity.ts
 */
import { Glob } from "bun";

interface Manifest {
	path: string;
	error: string;
}

/**
 * Manifest patterns, scanned separately: Bun's `Glob` does not expand a
 * `{a,b}` alternation here, and the root manifest plus the workspace ones are
 * the only two shapes that ship.
 */
const MANIFEST_GLOBS = ["package.json", "packages/*/package.json"] as const;

async function collectManifests(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const pattern of MANIFEST_GLOBS) {
		for await (const relative of new Glob(pattern).scan(root)) {
			if (existsSync(path.join(root, relative))) found.push(relative);
		}
	}
	return found;
}

async function main(): Promise<void> {
	const root = process.argv[2] ?? import.meta.dirname + "/..";
	const manifests = await collectManifests(root);
	const invalid: Manifest[] = [];
	for (const relative of manifests) {
		try {
			// `Bun.file().json()` is a strict parse: it rejects comments, trailing
			// commas and unquoted keys, which is exactly what must not ship.
			await Bun.file(path.join(root, relative)).json();
		} catch (error) {
			invalid.push({ path: relative, error: error instanceof Error ? error.message : String(error) });
		}
	}
	if (invalid.length > 0) {
		for (const { path: file, error } of invalid) console.error(`  ${file}: ${error}`);
		console.error(
			`\njson-validity: ${invalid.length} of ${manifests.length} manifest(s) are not valid JSON.` +
				"\nA trailing comma is the usual cause; a tolerant editor will not tell you.",
		);
		process.exit(1);
	}
	console.log(`json-validity: OK — ${manifests.length} manifest(s) parse as strict JSON.`);
}

if (import.meta.main) await main();
