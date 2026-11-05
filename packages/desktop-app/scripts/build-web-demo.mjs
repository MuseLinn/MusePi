/**
 * Web demo artifact: the real desktop renderer plus the fake-daemon bootstrap,
 * assembled into the static `web/app/` the marketing site ships.
 *
 * Only the files the booted shell asks for are copied — the request set was
 * recorded against a real dist build (index.html, its stylesheet, the entry
 * chunk and the seven chunks it statically imports, plus the welcome pet
 * spritesheet). Everything else in dist (`monaco-workers/`, `embedpdf/`, the
 * other pet sheets, the auxiliary HTML entries, the per-entry duplicate
 * stylesheets) is dead weight for the demo and is skipped.
 *
 * Font payload is pruned to what the shell actually paints, measured through
 * `document.fonts` on a booted build: Inter Variable and Source Serif 4 in
 * their normal faces. The KaTeX math faces, the italic faces, JetBrains Mono,
 * codicon and the two ~6MB CJK mono faces never load; the CJK mono stack falls
 * back to system monospace, math falls back to serif. The Monaco editor's CSS
 * goes with `monaco-workers/`, which the demo does not ship.
 *
 * The chat page, file workspace and right-panel shell are daemon-compiled slot
 * components in production, so they are not in the shell bundle either: each
 * one is compiled here with the daemon's own slot compiler (same externals,
 * same React instance) into `plugins/`, and the demo's `extensions.list` fixture
 * fetches them at boot. Their stylesheets repeat the shell's font faces and add
 * the KaTeX faces the demo does not ship, so only the rules survive.
 *
 * The artifact must stay under 24MiB; the check runs last so an oversized
 * artifact is still left on disk for inspection.
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { compileComponentModule } from "../../coding-agent/src/daemon/extension-artifact-compiler.ts";

const root = path.resolve(import.meta.dir, "../../..");
const dist = path.join(root, "packages/desktop-app/dist");
const out = path.join(root, "web/app");
const LIMIT_BYTES = 24 * 1024 * 1024;

const KEPT_FACES = new Set(["Inter Variable|normal", "Source Serif 4 Variable|normal"]);
const DROPPED_SELECTOR = /\b(monaco|codicon)\b/i;
/** Slot plugins ship no faces: the shell stylesheet already declares them. */
const PLUGIN_KEPT_FACES = new Set();

/** Plugin entries whose registered components the demo mounts. */
const PLUGIN_ENTRIES = [
	"packages/desktop-app/src/plugins/chat-view/index.ts",
	"packages/desktop-app/src/plugins/file-workspace/index.ts",
	"packages/desktop-app/src/plugins/panel/index.ts",
];

function fail(message) {
	console.error(`build:web-demo: ${message}`);
	process.exit(1);
}

function faceKey(block) {
	const family = /font-family:\s*(?:"([^"]+)"|([^;:]+))/.exec(block);
	const style = /font-style:\s*([^;]+)/.exec(block);
	return `${(family?.[1] ?? family?.[2] ?? "").trim()}|${style?.[1]?.trim() ?? "normal"}`;
}

function splitSelectorList(selector) {
	const parts = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < selector.length; i++) {
		const char = selector[i];
		if (char === "(" || char === "[") depth++;
		else if (char === ")" || char === "]") depth--;
		else if (char === "," && depth === 0) {
			parts.push(selector.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(selector.slice(start));
	return parts;
}

function pruneCss(css, keptFaces = KEPT_FACES) {
	let droppedBytes = 0;
	const faces = css.replace(/@font-face\{[^}]*\}/g, block => {
		if (keptFaces.has(faceKey(block))) return block;
		droppedBytes += block.length;
		return "";
	});
	const rules = faces.replace(/([^{}]+)\{([^{}]*)\}/g, (rule, selector, body) => {
		const parts = splitSelectorList(selector);
		const kept = parts.filter(part => !DROPPED_SELECTOR.test(part));
		if (kept.length === parts.length) return rule;
		const replacement = kept.length === 0 ? "" : `${kept.join(",")}{${body}}`;
		droppedBytes += rule.length - replacement.length;
		return replacement;
	});
	return { css: rules, droppedBytes };
}

function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}

function human(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

/**
 * Compile every plugin entry's registered component into `plugins/` and write
 * the manifest the demo fixture reads. Metadata comes from the plugin's own
 * `registerComponent` call — the same one the daemon collects — so the demo
 * cannot drift from the source it mounts.
 */
async function buildPlugins() {
	const dir = path.join(out, "plugins");
	mkdirSync(dir, { recursive: true });
	const components = [];
	const rows = [];
	for (const entry of PLUGIN_ENTRIES) {
		const source = path.join(root, entry);
		const plugin = await import(pathToFileURL(source).href);
		const registered = [];
		plugin.apply({
			setLabel() {},
			registerComponent(component) {
				registered.push(component);
			},
		});
		const [component] = registered;
		if (registered.length !== 1 || !component) fail(`${entry} must register exactly one component`);
		const name = path.basename(path.dirname(source));
		const compiled = await compileComponentModule(path.resolve(path.dirname(source), component.moduleUrl));
		writeFileSync(path.join(dir, `${name}.js`), compiled.code);
		const pruned = compiled.css ? pruneCss(compiled.css, PLUGIN_KEPT_FACES) : null;
		if (pruned) {
			if (/url\(\.\//.test(pruned.css)) fail(`plugins/${name}.css references a local asset the artifact does not ship`);
			writeFileSync(path.join(dir, `${name}.css`), pruned.css);
		}
		components.push({
			slot: component.slot,
			extensionId: entry,
			label: component.label,
			...(component.availability ? { availability: component.availability } : {}),
			...(component.order !== undefined ? { order: component.order } : {}),
			code: `${name}.js`,
			...(pruned ? { css: `${name}.css` } : {}),
		});
		rows.push({ name, code: compiled.code, css: pruned?.css ?? null, droppedBytes: pruned?.droppedBytes ?? 0 });
	}
	writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({ components }, null, "\t")}\n`);
	return rows;
}

function walk(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(abs));
		else files.push({ path: path.relative(out, abs).split(path.sep).join("/"), bytes: statSync(abs).size });
	}
	return files;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const bundle = await Bun.build({
	entrypoints: [path.join(root, "web/demo-src/index.js")],
	target: "browser",
	format: "iife",
	minify: true,
	naming: "demo-boot.js",
	outdir: out,
});
if (!bundle.success) {
	for (const log of bundle.logs) console.error(log);
	fail("demo-boot bundle failed");
}

const plugins = await buildPlugins();

const distIndex = readFileSync(path.join(dist, "index.html"), "utf8");
const entryChunk = /<script type="module"[^>]*src="\.\/([\w.-]+\.js)"/.exec(distIndex)?.[1];
const stylesheet = /<link rel="stylesheet"[^>]*href="\.\/([\w.-]+\.css)"/.exec(distIndex)?.[1];
if (!entryChunk || !stylesheet) fail("dist/index.html no longer exposes an entry chunk and stylesheet");

const preloads = [...distIndex.matchAll(/<link rel="modulepreload"[^>]*href="\.\/([\w.-]+\.js)"/g)].map(m => m[1]);
const chunks = new Set();
const queue = [entryChunk, ...preloads];
while (queue.length > 0) {
	const name = queue.pop();
	if (chunks.has(name)) continue;
	if (!existsSync(path.join(dist, name))) fail(`dist/${name} is referenced but missing`);
	chunks.add(name);
	const source = readFileSync(path.join(dist, name), "utf8");
	for (const match of source.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) queue.push(match[1]);
}

for (const name of chunks) copyFileSync(path.join(dist, name), path.join(out, name));

// The preset grid can paint the MusePi spritesheet (the default companion is
// the code-drawn orb, which needs no asset); the other sheets stay out.
const petSheet = "pets/musepi.webp";
if (!existsSync(path.join(dist, petSheet))) fail(`dist/${petSheet} is missing`);
mkdirSync(path.join(out, "pets"), { recursive: true });
copyFileSync(path.join(dist, petSheet), path.join(out, petSheet));

const { css, droppedBytes } = pruneCss(readFileSync(path.join(dist, stylesheet), "utf8"));
writeFileSync(path.join(out, stylesheet), css);

const shipped = new Set([...chunks, stylesheet, "demo-boot.js", "index.html"]);
for (const [, ref] of css.matchAll(/url\(\.\/([^)"']+)\)/g)) {
	if (!shipped.has(ref)) fail(`${stylesheet} still references ${ref}, which the artifact does not ship`);
}

const stylesheetTag = '<link rel="stylesheet"';
if (distIndex.split(stylesheetTag).length !== 2) fail("dist/index.html has an unexpected stylesheet tag count");
const scriptTag = '<script src="./demo-boot.js"></script>';
writeFileSync(path.join(out, "index.html"), distIndex.replace(stylesheetTag, `${scriptTag}${stylesheetTag}`));

const consumed = [...chunks, stylesheet, petSheet, "index.html"].sort();
const distHash = sha256(consumed.map(name => `${name}\n${sha256(readFileSync(path.join(dist, name)))}`).join("\n"));

const payload = walk(out);
const payloadBytes = payload.reduce((sum, file) => sum + file.bytes, 0);

const header = {
	builtAt: new Date().toISOString(),
	distHash: `sha256:${distHash}`,
	distFiles: consumed,
	fileCount: payload.length + 1,
	totalBytes: payloadBytes,
};
let manifest = "";
let totalBytes = payloadBytes;
for (let attempt = 0; attempt < 4; attempt++) {
	manifest = `${JSON.stringify({ ...header, totalBytes }, null, "\t")}\n`;
	const next = payloadBytes + Buffer.byteLength(manifest);
	if (next === totalBytes) break;
	totalBytes = next;
}
writeFileSync(path.join(out, "MANIFEST.json"), manifest);

for (const plugin of plugins) {
	const code = readFileSync(path.join(out, "plugins", `${plugin.name}.js`));
	const css = plugin.css === null ? null : readFileSync(path.join(out, "plugins", `${plugin.name}.css`));
	const parts = [`js ${human(code.length)} raw / ${human(gzipSync(code).length)} gzip`];
	if (css) parts.push(`css ${human(css.length)} raw / ${human(gzipSync(css).length)} gzip`);
	if (plugin.droppedBytes > 0) parts.push(`fonts pruned ${human(plugin.droppedBytes)}`);
	console.log(`plugin ${plugin.name.padEnd(14)} ${parts.join(", ")}`);
}

const rows = [...payload, { path: "MANIFEST.json", bytes: Buffer.byteLength(manifest) }];
rows.sort((a, b) => b.bytes - a.bytes);
const width = Math.max(...rows.map(row => row.path.length), "total".length);
const line = (name, bytes) => `${name.padEnd(width)}  ${String(bytes).padStart(9)}  ${human(bytes).padStart(10)}`;
for (const row of rows) console.log(line(row.path, row.bytes));
console.log(`${line("total", totalBytes)}  (limit ${human(LIMIT_BYTES)}, css pruned ${human(droppedBytes)})`);

if (totalBytes > LIMIT_BYTES) fail(`artifact is ${human(totalBytes)}, over the ${human(LIMIT_BYTES)} budget`);
