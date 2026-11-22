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
 * registered slot is compiled here with the daemon's own slot compiler (same
 * externals, same React instance) into `plugins/`, and the demo's
 * `extensions.list` fixture fetches them at boot. A plugin may own several
 * slots — chat-view contributes both `main.conversation` and the composer bar —
 * so the build reads registrations per slot rather than assuming one each.
 * Their stylesheets repeat the shell's font faces and add the KaTeX faces the
 * demo does not ship, so only the rules survive.
 *
 * The artifact is assembled in `.tmp/web-demo-build/` and swapped into
 * `web/app` only after every check passes, so a failed run leaves the
 * published (and checked-in) artifact untouched. The size check runs last, so
 * an oversized stage is still readable for inspection.
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { compileComponentModule } from "../../../packages/coding-agent/src/daemon/extension-artifact-compiler.ts";

const root = path.resolve(import.meta.dir, "../../..");
const dist = path.join(root, "apps/desktop/dist");
const out = path.join(root, "web/app");
/**
 * Budgets. The raw cap bounds what gets checked into git; the gzip cap bounds
 * what a visitor actually downloads, which is the number that decides whether
 * the preview is usable. Raw grew past the original 24MiB when the composer
 * moved into its own slot and the panel/file bundles grew, so the raw cap was
 * raised once and the transfer cap added — a further raw increase must justify
 * itself against the visitor's download, not just the repository's size.
 */
const LIMIT_BYTES = 28 * 1024 * 1024;
const TRANSFER_LIMIT_BYTES = 9 * 1024 * 1024;

const KEPT_FACES = new Set(["Inter Variable|normal", "Source Serif 4 Variable|normal"]);
const DROPPED_SELECTOR = /\b(monaco|codicon)\b/i;
/** Slot plugins ship no faces: the shell stylesheet already declares them. */
const PLUGIN_KEPT_FACES = new Set();

/** Plugin entries whose registered components the demo mounts. */
const PLUGIN_ENTRIES = [
	"apps/desktop/src/plugins/chat-view/index.ts",
	"apps/desktop/src/plugins/file-workspace/index.ts",
	"apps/desktop/src/plugins/panel/index.ts",
];

/**
 * Slots the booted demo shell renders. A build that ships a manifest missing
 * one of these boots to a blank surface (no error, just nothing inside the
 * slot host), so the absence is a build failure rather than a silent hole.
 */
const REQUIRED_SLOTS = ["main.conversation", "conversation.composer.bar", "panel.tab.files", "panel.shell"];

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
 * Compile every plugin entry's registered slot components into `plugins/` and
 * write the manifest the demo fixture reads.
 *
 * The context handed to `apply()` mirrors the daemon's: `ctx.slots.register`
 * and the legacy `ctx.registerComponent` are the same collector (the real
 * loader binds both to `registerComponent`), so a plugin may call either. A
 * plugin may register for several slots — chat-view owns `main.conversation`
 * and `conversation.composer.bar` — so registrations are consumed keyed by
 * slot, never by a count. Every registered slot the demo mounts gets its own
 * compiled module.
 */
async function buildPlugins(dir) {
	mkdirSync(dir, { recursive: true });
	const components = [];
	const rows = [];
	for (const entry of PLUGIN_ENTRIES) {
		const source = path.join(root, entry);
		const plugin = await import(pathToFileURL(source).href);
		const registered = [];
		const register = component => {
			if (!component || typeof component.slot !== "string" || !component.slot) {
				fail(`${entry} registered a component without a slot`);
			}
			if (registered.some(existing => existing.slot === component.slot)) {
				fail(`${entry} registered slot ${component.slot} twice`);
			}
			registered.push(component);
		};
		plugin.apply({ setLabel() {}, slots: { register }, registerComponent: register });
		if (registered.length === 0) fail(`${entry} registered no slot components`);
		const bySlot = new Map(registered.map(component => [component.slot, component]));
		const name = path.basename(path.dirname(source));
		// The first registration keeps the plugin's own name; further slots get
		// a slot-derived suffix so two modules never collide on one filename.
		for (const [index, component] of registered.entries()) {
			const file = index === 0 ? name : `${name}.${component.slot.replace(/[^\w]+/g, "-")}`;
			const compiled = await compileComponentModule(
				path.resolve(path.dirname(source), component.moduleUrl),
			);
			writeFileSync(path.join(dir, `${file}.js`), compiled.code);
			const pruned = compiled.css ? pruneCss(compiled.css, PLUGIN_KEPT_FACES) : null;
			if (pruned) {
				if (/url\(\.\//.test(pruned.css)) {
					fail(`plugins/${file}.css references a local asset the artifact does not ship`);
				}
				writeFileSync(path.join(dir, `${file}.css`), pruned.css);
			}
			components.push({
				slot: component.slot,
				extensionId: entry,
				label: component.label,
				...(component.availability ? { availability: component.availability } : {}),
				...(component.order !== undefined ? { order: component.order } : {}),
				code: `${file}.js`,
				...(pruned ? { css: `${file}.css` } : {}),
			});
			rows.push({
				name: file,
				code: compiled.code,
				css: pruned?.css ?? null,
				droppedBytes: pruned?.droppedBytes ?? 0,
			});
		}
		// Every slot the host renders must be filled by exactly one component;
		// a second registration for a slot means the demo cannot choose.
		if (bySlot.size !== registered.length) fail(`${entry} registered the same slot more than once`);
	}
	for (const slot of REQUIRED_SLOTS) {
		if (!components.some(component => component.slot === slot)) {
			fail(`no plugin registered ${slot}, which the demo shell renders`);
		}
	}
	writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify({ components }, null, "\t")}\n`);
	return rows;
}

function walk(base, dir = base) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...walk(base, abs));
		else files.push({ path: path.relative(base, abs).split(path.sep).join("/"), bytes: statSync(abs).size });
	}
	return files;
}

/**
 * Build into `stage` and only replace `web/app` once every step succeeded, so
 * a failed run leaves the published artifact (and the visitor's page) intact.
 *
 * The swap renames the previous artifact to `web/app.previous` and the finished
 * stage into place; whatever the outcome, the previous directory is removed.
 * A crash between the two renames would leave the site without `web/app`, so
 * the window is kept to two synchronous renames rather than a copy.
 */
const stage = path.join(root, ".tmp/web-demo-build");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const bundle = await Bun.build({
	entrypoints: [path.join(root, "web/demo-src/index.js")],
	target: "browser",
	format: "iife",
	minify: true,
	naming: "demo-boot.js",
	outdir: stage,
});
if (!bundle.success) {
	for (const log of bundle.logs) console.error(log);
	fail("demo-boot bundle failed");
}

const plugins = await buildPlugins(path.join(stage, "plugins"));

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

for (const name of chunks) copyFileSync(path.join(dist, name), path.join(stage, name));

// The preset grid can paint the MusePi spritesheet (the default companion is
// the code-drawn orb, which needs no asset); the other sheets stay out.
const petSheet = "pets/musepi.webp";
if (!existsSync(path.join(dist, petSheet))) fail(`dist/${petSheet} is missing`);
mkdirSync(path.join(stage, "pets"), { recursive: true });
copyFileSync(path.join(dist, petSheet), path.join(stage, petSheet));

const { css, droppedBytes } = pruneCss(readFileSync(path.join(dist, stylesheet), "utf8"));
writeFileSync(path.join(stage, stylesheet), css);

const shipped = new Set([...chunks, stylesheet, "demo-boot.js", "index.html"]);
for (const [, ref] of css.matchAll(/url\(\.\/([^)"']+)\)/g)) {
	if (!shipped.has(ref)) fail(`${stylesheet} still references ${ref}, which the artifact does not ship`);
}

const stylesheetTag = '<link rel="stylesheet"';
if (distIndex.split(stylesheetTag).length !== 2) fail("dist/index.html has an unexpected stylesheet tag count");
const scriptTag = '<script src="./demo-boot.js"></script>';
writeFileSync(path.join(stage, "index.html"), distIndex.replace(stylesheetTag, `${scriptTag}${stylesheetTag}`));

const consumed = [...chunks, stylesheet, petSheet, "index.html"].sort();
const distHash = sha256(consumed.map(name => `${name}\n${sha256(readFileSync(path.join(dist, name)))}`).join("\n"));

const payload = walk(stage);
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
writeFileSync(path.join(stage, "MANIFEST.json"), manifest);

for (const plugin of plugins) {
	const code = readFileSync(path.join(stage, "plugins", `${plugin.name}.js`));
	const css = plugin.css === null ? null : readFileSync(path.join(stage, "plugins", `${plugin.name}.css`));
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

// Transfer weight: what one visitor downloads on first load, gzipped the way
// a static host would serve it.
const transferBytes = walk(stage).reduce(
	(sum, file) => sum + gzipSync(readFileSync(path.join(stage, file.path))).length,
	0,
);
console.log(
	`${line("total", totalBytes)}  (raw limit ${human(LIMIT_BYTES)}, css pruned ${human(droppedBytes)})`,
);
console.log(`${line("transfer", transferBytes)}  (gzip limit ${human(TRANSFER_LIMIT_BYTES)})`);

if (totalBytes > LIMIT_BYTES) fail(`artifact is ${human(totalBytes)}, over the ${human(LIMIT_BYTES)} raw budget`);
if (transferBytes > TRANSFER_LIMIT_BYTES) {
	fail(`artifact transfers ${human(transferBytes)} gzipped, over the ${human(TRANSFER_LIMIT_BYTES)} budget`);
}

// Every check passed: swap the finished stage into place. The old artifact is
// removed only after the new one is already named `web/app`, so a visitor
// never sees a half-written directory.
const previous = `${out}.previous`;
rmSync(previous, { recursive: true, force: true });
if (existsSync(out)) renameSync(out, previous);
renameSync(stage, out);
rmSync(previous, { recursive: true, force: true });
