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

// fileURLToPath, not .pathname: on Windows .pathname yields "/C:/…" which
// readdirSync/copyFileSync cannot resolve.
const dir = fileURLToPath(new URL("../dist/", import.meta.url));
const htmlFiles = readdirSync(dir).filter(f => f.endsWith(".html"));
for (const file of htmlFiles) {
	const content = readFileSync(`${dir}${file}`, "utf8");
	const fixed = content
		.replaceAll('<script type="module" crossorigin src=', '<script type="module" src=')
		.replaceAll('<link rel="stylesheet" crossorigin href=', '<link rel="stylesheet" href=');
	if (fixed !== content) {
		writeFileSync(`${dir}${file}`, fixed);
		console.log(`dist/${file}: stripped crossorigin (file:// CORS fix)`);
	}
}

// Builtin chiikawa pet spritesheets (public/pets) ship alongside the HTML
// entries so both the app and the pet window can load them by relative path.
const petsSrc = fileURLToPath(new URL("../public/pets/", import.meta.url));
const petsDst = `${dir}pets/`;
mkdirSync(petsDst, { recursive: true });
for (const file of readdirSync(petsSrc)) {
	copyFileSync(`${petsSrc}${file}`, `${petsDst}${file}`);
	console.log(`dist/pets/${file}`);
}
