#!/usr/bin/env node
/**
 * Copy the client-core mobile bundle into the HarmonyOS rawfile directory.
 *
 * Usage: node scripts/copy-web-assets.js
 * Run after `bun run build` in packages/client-core. mobile.html becomes
 * rawfile/index.html (the shell loads $rawfile('index.html')); the hashed
 * asset files sit next to it so relative references resolve.
 *
 * The copy is incremental: files are overwritten, then only entries that no
 * longer exist in dist are pruned. A full `rm -rf` of the directory (what this
 * used to do) is both slower and, on machines with a delete guard, refused
 * outright — which left rawfile half-deleted and the next build failing with
 * "No such 'index.html' resource in current module".
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harmonyRoot = join(here, "..");
// The bundle lives in packages/client-core (the old `guest-client` name is
// kept as a fallback so a stale checkout still resolves).
const distCandidates = ["client-core", "guest-client"].map((name) => join(harmonyRoot, "..", name, "dist"));
const dist = distCandidates.find((candidate) => existsSync(join(candidate, "mobile.html")));
const rawfile = join(harmonyRoot, "entry", "src", "main", "resources", "rawfile");

if (!dist) {
	console.error("[copy-web-assets] mobile bundle not found — run `bun run build` in packages/client-core first");
	process.exit(1);
}

/** Every file under `root`, as a posix-style relative path. */
function listFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else out.push(relative(root, full).split(sep).join("/"));
		}
	};
	if (existsSync(root)) walk(root);
	return out;
}

mkdirSync(rawfile, { recursive: true });
cpSync(dist, rawfile, { recursive: true });

// Promote the mobile entry over the desktop one: the shell loads index.html
// and the desktop entry would dead-end inside it.
writeFileSync(join(rawfile, "index.html"), readFileSync(join(dist, "mobile.html"), "utf8"));
rmSync(join(rawfile, "mobile.html"), { force: true });

// Prune only what this build no longer produces (hashed asset names change
// every build, so this is a handful of files, never a bulk delete).
const wanted = new Set(listFiles(dist));
wanted.delete("mobile.html");
for (const file of listFiles(rawfile)) {
	if (wanted.has(file)) continue;
	rmSync(join(rawfile, file), { force: true });
}

// Remove now-empty directories left behind by the prune (bottom-up).
const pruneEmptyDirs = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = join(dir, entry.name);
		pruneEmptyDirs(full);
		if (statSync(full).isDirectory() && readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
	}
};
pruneEmptyDirs(rawfile);

console.log(`[copy-web-assets] rawfile ready (${rawfile})`);
