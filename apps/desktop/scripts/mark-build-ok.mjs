import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Written only after every build step succeeds; `desktop-run` reads its
 *  mtime as the build stamp, so a failed parallel step never looks fresh. */
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(pkgDir, "dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, ".build-ok"), `${new Date().toISOString()}\n`);
console.log("build: stamp written");
