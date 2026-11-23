/**
 * Build-time compilation of the app's own plugin components.
 *
 * The daemon can compile a plugin's `page.tsx` on demand, but for the app's
 * *first-party* plugins that is the wrong moment: they are part of this bundle's
 * source, so compiling them at boot duplicates their dependencies into every
 * artifact and puts a multi-second build in front of the first window. The app
 * builds them here instead, with the very configuration the daemon uses
 * (`componentBuildConfig`), and the daemon serves the result from the manifest
 * (`MUSEPI_PLUGIN_ARTIFACTS`) while falling back to an on-demand compile for
 * anything this pass did not cover.
 *
 * `splitting` stays off: each artifact is delivered as one module over the
 * artifact origin, so a relative chunk import would resolve against that origin
 * rather than the build directory. Sharing chunks is the next step, not a
 * property of this pass.
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	componentBuildConfig,
	sourceStamp,
} from "../../../packages/coding-agent/src/daemon/extension-artifact-compiler";
import { type DeclaredSlot, type ManifestDeclaration, mergeDeclarations, parseDeclaredSlots } from "./plugin-manifest";

const pkgDir = path.resolve(import.meta.dir, "..");
const repoRoot = path.resolve(pkgDir, "..", "..");
const pluginsDir = path.join(pkgDir, "src", "plugins");
const bundledDir = path.join(repoRoot, "packages", "coding-agent", "src", "plugins");
const outDir = path.join(pkgDir, "dist", "plugins");

/** Every compiled component entry this app can serve.
 *
 *  A plugin declares its surfaces as `moduleUrl: "./<file>"` in its own entry
 *  module, and the name is not always `page.tsx` (`rail.tsx`, `settings.tsx`,
 *  `host.tsx`), so the declaration is what this scan follows instead of a file
 *  naming convention — a convention silently misses surfaces, and a missed
 *  surface is compiled again on the daemon's first boot. */
async function entrypoints(): Promise<string[]> {
	const found = new Set<string>();
	const addDeclared = async (dir: string): Promise<void> => {
		let text: string;
		try {
			text = await Bun.file(path.join(dir, "index.ts")).text();
		} catch {
			return;
		}
		for (const match of text.matchAll(/moduleUrl:\s*"\.\/([^"]+)"/g)) {
			const file = path.resolve(dir, match[1] ?? "");
			if (await Bun.file(file).exists()) found.add(file);
		}
	};
	for (const dir of await readdir(pluginsDir, { withFileTypes: true })) {
		if (dir.isDirectory()) await addDeclared(path.join(pluginsDir, dir.name));
	}
	// The host's plugin tree groups packages by domain
	// (`plugins/<domain>/<package>`), so a package is any directory holding a
	// `package.json`; a domain is a directory that holds those.
	for (const dir of await readdir(bundledDir, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const candidate = path.join(bundledDir, dir.name);
		if (await Bun.file(path.join(candidate, "package.json")).exists()) {
			await addDeclared(candidate);
			continue;
		}
		for (const nested of await readdir(candidate, { withFileTypes: true })) {
			if (nested.isDirectory()) await addDeclared(path.join(candidate, nested.name));
		}
	}
	return [...found].sort();
}

/** Slot declarations a plugin's entry module makes, read from disk.
 *
 *  Parsing lives in `./plugin-manifest` so the accumulation rule has one home
 *  that a test can exercise without running a build. */
async function declaredSlots(dir: string): Promise<DeclaredSlot[] | undefined> {
	let text: string;
	try {
		text = await Bun.file(path.join(dir, "index.ts")).text();
	} catch {
		return undefined;
	}
	return parseDeclaredSlots(text);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const entries = await entrypoints();
const entriesOut: Record<string, { file: string; css?: string; mtimeMs: number; size: number }> = {};
// Slot declarations per plugin entry module, keyed the same way as `entries`.
const declarations: Record<string, ManifestDeclaration[]> = {};
// Which optional surfaces a plugin declares at all. A collector that asks for
// one of these can skip mounting the plugin when the build says it has none —
// enumerating an empty set was costing a full module-graph load per plugin.
const surfaces: Record<string, { toolViews?: boolean; widgets?: boolean; statusBar?: boolean; skins?: boolean }> = {};
let stamp = 0;

for (const entry of entries) {
	const info = await Bun.file(entry).stat();
	stamp = Math.max(stamp, sourceStamp(entry));
	const result = await Bun.build(componentBuildConfig([entry]));
	if (!result.success || result.outputs.length === 0) {
		console.error(`build:plugins — ${entry} failed:\n${result.logs.map(l => l.message).join("\n")}`);
		process.exit(1);
	}
	const codeOutput = result.outputs.find(o => o.path.endsWith(".js"));
	if (!codeOutput) {
		console.error(`build:plugins — ${entry} produced no JavaScript output`);
		process.exit(1);
	}
	// A plugin can declare several surfaces; the artifact key is the plugin
	// directory plus the declared file, so no two entries can claim one name.
	const pluginDir = path.basename(path.dirname(entry));
	const name = `${pluginDir}-${path.basename(entry, ".tsx")}`;
	const codeFile = `${name}.js`;
	await writeFile(path.join(outDir, codeFile), await codeOutput.text());
	const cssOutput = result.outputs.find(o => o.path.endsWith(".css"));
	const cssText = cssOutput ? await cssOutput.text() : "";
	let cssFile: string | undefined;
	if (cssText.trim().length > 0) {
		cssFile = `${name}.css`;
		await writeFile(path.join(outDir, cssFile), cssText);
	}
	entriesOut[entry.replace(/\\/g, "/")] = {
		file: codeFile,
		...(cssFile ? { css: cssFile } : {}),
		mtimeMs: info.mtimeMs,
		size: info.size,
	};
	// A bundled plugin keeps its surfaces under `ui/`, one level below the entry
	// module that declares them.
	const pluginRoot = entry.includes(`${path.sep}ui${path.sep}`)
		? path.dirname(path.dirname(entry))
		: path.dirname(entry);
	const declared = await declaredSlots(pluginRoot);
	if (declared !== undefined) {
		const relative = path.relative(pluginRoot, entry).split(path.sep).join("/");
		const entryKey = path.join(pluginRoot, "index.ts").split(path.sep).join("/");
		const source = await Bun.file(path.join(pluginRoot, "index.ts"))
			.text()
			.catch(() => "");
		surfaces[entryKey] = {
			toolViews: /registerToolView\(/.test(source),
			widgets: /registerWidget\(/.test(source),
			statusBar: /registerStatusBarSegment\(/.test(source),
			skins: /registerScrollbarSkin\(/.test(source),
		};
		declarations[entryKey] = mergeDeclarations(declarations[entryKey], declared, {
			relative,
			file: codeFile,
			...(cssFile ? { css: cssFile } : {}),
		});
	}
}

await writeFile(
	path.join(outDir, "manifest.json"),
	`${JSON.stringify({ stamp, entries: entriesOut, declarations, surfaces }, null, "\t")}\n`,
);
console.log(`build:plugins — ${entries.length} artifacts, stamp ${stamp}`);
