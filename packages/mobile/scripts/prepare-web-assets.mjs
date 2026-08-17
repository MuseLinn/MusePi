// Prepare the Capacitor webDir from the desktop-web build: copy the shared
// dist, then rewrite mobile.html → index.html so the native shell always
// launches the mobile entry (openchamber pattern — no runtime redirect, the
// APK contains only the mobile surface). The desktop-web dist itself is left
// untouched for desktop browsers.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collabDist = path.resolve(mobileRoot, "../desktop-web/dist");
const mobileDist = path.resolve(mobileRoot, "dist");

await rm(mobileDist, { recursive: true, force: true });
await mkdir(mobileDist, { recursive: true });
await cp(collabDist, mobileDist, { recursive: true });

const mobileHtml = path.join(mobileDist, "mobile.html");
const indexHtml = path.join(mobileDist, "index.html");
const html = await readFile(mobileHtml, "utf8");
await writeFile(indexHtml, html);
console.log(`[prepare-web-assets] ${path.relative(mobileRoot, mobileDist)} ready (mobile.html → index.html)`);
