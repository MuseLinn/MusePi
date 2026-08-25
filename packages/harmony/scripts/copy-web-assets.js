#!/usr/bin/env node
/**
 * Copy the desktop-web mobile bundle into the HarmonyOS rawfile directory.
 *
 * Usage: node scripts/copy-web-assets.js
 * Run after `bun run build` in packages/desktop-web. mobile.html becomes
 * rawfile/index.html (the shell loads $rawfile('index.html')); the hashed
 * asset files sit next to it so relative references resolve.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const harmonyRoot = join(here, "..");
const dist = join(harmonyRoot, "..", "desktop-web", "dist");
const rawfile = join(harmonyRoot, "entry", "src", "main", "resources", "rawfile");

if (!existsSync(join(dist, "mobile.html"))) {
	console.error("[copy-web-assets] desktop-web dist not found — run `bun run build` in packages/desktop-web first");
	process.exit(1);
}

rmSync(rawfile, { recursive: true, force: true });
mkdirSync(rawfile, { recursive: true });

// Copy everything, then promote mobile.html to index.html (the desktop
// index.html is not used by the shell).
cpSync(dist, rawfile, { recursive: true });

const mobile = readFileSync(join(rawfile, "mobile.html"), "utf8");
writeFileSync(join(rawfile, "index.html"), mobile);
rmSync(join(rawfile, "mobile.html"));
// The desktop entry would dead-end in the shell — drop it.
rmSync(join(rawfile, "index-*.html"), { force: true });

console.log(`[copy-web-assets] rawfile ready (${rawfile})`);
