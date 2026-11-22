import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy Monaco's five language workers into `dist/monaco-workers/`.
 *
 * The package is not necessarily under this package's node_modules: an
 * isolated install keeps it here, a hoisted install keeps it at the repo
 * root. Resolve the installed entry and walk up to the package root, then
 * match each worker by its stable prefix instead of a content hash that
 * changes with every Monaco release.
 */
const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(pkgDir, "dist", "monaco-workers");
const require = createRequire(join(pkgDir, "package.json"));

let entry;
try {
	entry = require.resolve("monaco-editor");
} catch {
	throw new Error("monaco-editor is not installed; run `bun install` before building the desktop app.");
}

let root = dirname(entry);
while (!existsSync(join(root, "min", "vs", "assets"))) {
	const parent = dirname(root);
	if (parent === root) throw new Error(`monaco-editor package root not found from ${entry}`);
	root = parent;
}
const assets = join(root, "min", "vs", "assets");
const available = readdirSync(assets);
const workers = {
	"editor.worker": "editor.worker.js",
	"json.worker": "json.worker.js",
	"css.worker": "css.worker.js",
	"html.worker": "html.worker.js",
	"ts.worker": "ts.worker.js",
};

mkdirSync(outDir, { recursive: true });
for (const [prefix, name] of Object.entries(workers)) {
	const file = available.find(candidate => candidate.startsWith(`${prefix}-`) && candidate.endsWith(".js"));
	if (!file) throw new Error(`monaco worker ${prefix} not found in ${assets}`);
	copyFileSync(join(assets, file), join(outDir, name));
}
console.log(`monaco: ${Object.keys(workers).length} workers copied from ${assets}`);
