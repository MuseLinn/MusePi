/**
 * Dist HTML post-fix: bun build hashes EVERY entry including the two
 * HTML files (index.html + pet.html). Restore stable names by matching
 * the <title> tag — the pet window entry is the one titled "MusePi Pet".
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// fileURLToPath, not .pathname: on Windows .pathname yields "/C:/…" which
// readdirSync/copyFileSync cannot resolve.
const dir = fileURLToPath(new URL("../dist/", import.meta.url));
const htmlFiles = readdirSync(dir).filter(f => f.endsWith(".html"));
for (const file of htmlFiles) {
	const content = readFileSync(`${dir}${file}`, "utf8");
	const name = content.includes("<title>MusePi Pet</title>")
		? "pet.html"
		: content.includes("<title>MusePi Bubbles</title>")
			? "bubble.html"
			: content.includes("<title>MusePi Pin</title>")
				? "pin.html"
				: content.includes("<title>MusePi Tray</title>")
					? "tray-menu.html"
					: "index.html";
	renameSync(`${dir}${file}`, `${dir}${name}`);
	console.log(`dist/${file} -> dist/${name}`);
	// Electron loads dist via file:// — bun 1.3.14 emits module scripts and
	// stylesheet links with `crossorigin`, which makes Chromium enforce CORS
	// on file-origin subresources (origin "null" can never satisfy it) and
	// the renderer goes blank after every rebuild. Strip the attribute so
	// plain file:// loading works (bun 1.3.13 and earlier didn't emit it).
	const fixed = content
		.replaceAll('<script type="module" crossorigin src=', '<script type="module" src=')
		.replaceAll('<link rel="stylesheet" crossorigin href=', '<link rel="stylesheet" href=');
	if (fixed !== content) {
		writeFileSync(`${dir}${name}`, fixed);
		console.log(`dist/${name}: stripped crossorigin (file:// CORS fix)`);
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
