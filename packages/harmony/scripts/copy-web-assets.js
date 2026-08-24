/**
 * Copies the built desktop-web dist into the HarmonyOS rawfile directory so
 * the ArkTS WebView can load it via $rawfile('index.html').
 *
 * The shell loads the *mobile* entry (src/mobile.tsx — the Capacitor-shell
 * bundle with native chrome), which the desktop-web build emits as
 * `mobile.html`. It is renamed to `index.html` in rawfile so Index.ets can
 * reference a stable $rawfile('index.html') regardless of shell.
 *
 * Usage:
 *   bun run build                       # in packages/desktop-web → dist/
 *   node scripts/copy-web-assets.js     # in packages/harmony
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const harmony = path.resolve(here, "..");
const webDist = path.resolve(harmony, "../desktop-web/dist");
const rawfile = path.join(harmony, "entry/src/main/resources/rawfile");

if (!existsSync(path.join(webDist, "mobile.html"))) {
	console.error(
		`[harmony] ${path.join(webDist, "mobile.html")} not found — run "bun run build" in packages/desktop-web first.`,
	);
	process.exit(1);
}

rmSync(rawfile, { recursive: true, force: true });
mkdirSync(rawfile, { recursive: true });
cpSync(webDist, rawfile, { recursive: true });

// (This overwrites the desktop-web entry's index.html, which is unused.)
renameSync(path.join(rawfile, "mobile.html"), path.join(rawfile, "index.html"));

// Strip the PWA manifest / favicon — the native shell supplies its own icon.
for (const name of ["mobile.webmanifest", "favicon.ico"]) {
	const p = path.join(rawfile, name);
	if (existsSync(p)) rmSync(p, { force: true });
}

// Report the copied size.
let bytes = 0;
const walk = (dir) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(p);
		else bytes += statSync(p).size;
	}
};
walk(rawfile);
console.log(`[harmony] copied ${webDist} → ${rawfile} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);
