/**
 * Dist HTML post-fix: bun 1.3.14 emits module scripts and stylesheet links
 * with `crossorigin`, which makes Chromium enforce CORS on file-origin
 * subresources (origin "null" can never satisfy it) and the renderer goes
 * blank after every rebuild. Strip the attribute so plain file:// loading
 * works (bun 1.3.13 and earlier didn't emit it).
 *
 * HTML entry names are stable (build:bundle no longer hashes them), so no
 * rename is needed.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// VERBOSE=1 prints every touched file; default prints one summary line per
// phase so a dev-loop `desktop` start stays readable.
const VERBOSE = process.env.VERBOSE === "1";

// fileURLToPath, not .pathname: on Windows .pathname yields "/C:/…" which
// readdirSync/copyFileSync cannot resolve.
const dir = fileURLToPath(new URL("../dist/", import.meta.url));
const htmlFiles = readdirSync(dir).filter(f => f.endsWith(".html"));
let stripped = 0;
for (const file of htmlFiles) {
	const content = readFileSync(`${dir}${file}`, "utf8");
	const fixed = content
		.replaceAll('<script type="module" crossorigin src=', '<script type="module" src=')
		.replaceAll('<link rel="stylesheet" crossorigin href=', '<link rel="stylesheet" href=');
	if (fixed !== content) {
		writeFileSync(`${dir}${file}`, fixed);
		stripped++;
		if (VERBOSE) console.log(`dist/${file}: stripped crossorigin (file:// CORS fix)`);
	}
}
if (stripped > 0) console.log(`dist: stripped crossorigin in ${stripped} html entr${stripped === 1 ? "y" : "ies"} (file:// CORS fix)`);

// Builtin chiikawa pet spritesheets (public/pets) ship alongside the HTML
// entries so both the app and the pet window can load them by relative path.
const petsSrc = fileURLToPath(new URL("../public/pets/", import.meta.url));
const petsDst = `${dir}pets/`;
mkdirSync(petsDst, { recursive: true });
const petFiles = readdirSync(petsSrc);
for (const file of petFiles) {
	copyFileSync(`${petsSrc}${file}`, `${petsDst}${file}`);
	if (VERBOSE) console.log(`dist/pets/${file}`);
}
console.log(`dist: ${petFiles.length} pet sprite(s) shipped`);
