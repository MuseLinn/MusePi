/**
 * Dist HTML post-fix: bun build hashes EVERY entry including the two
 * HTML files (index.html + pet.html). Restore stable names by matching
 * the <title> tag — the pet window entry is the one titled "MusePi Pet".
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";

const dir = new URL("../dist/", import.meta.url).pathname;
const htmlFiles = readdirSync(dir).filter(f => f.endsWith(".html"));
for (const file of htmlFiles) {
	const content = readFileSync(`${dir}${file}`, "utf8");
	const name = content.includes("<title>MusePi Pet</title>")
		? "pet.html"
		: content.includes("<title>MusePi Pin</title>")
			? "pin.html"
			: "index.html";
	renameSync(`${dir}${file}`, `${dir}${name}`);
	console.log(`dist/${file} -> dist/${name}`);
}

// Builtin chiikawa pet spritesheets (public/pets) ship alongside the HTML
// entries so both the app and the pet window can load them by relative path.
const petsSrc = new URL("../public/pets/", import.meta.url).pathname;
const petsDst = `${dir}pets/`;
mkdirSync(petsDst, { recursive: true });
for (const file of readdirSync(petsSrc)) {
	copyFileSync(`${petsSrc}${file}`, `${petsDst}${file}`);
	console.log(`dist/pets/${file}`);
}
