import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import * as path from "node:path";
import {
	EXTENSION_HOST_MODULES,
	type ExtensionHostModuleDeclaration,
	matchExtensionHostModule,
} from "@musepi/collab-proto/extension-host-modules";
import { getExtensionArtifactCacheDir, logger } from "@musepi/pi-utils";
import type { BunPlugin } from "bun";
import { LEGACY_EXTENSION_MODULE_KIND, PLUGIN_MODULE_KIND } from "../capability/extension-module";
import type { Extension } from "../extensibility/extensions/types";
import type { PresetPluginRow } from "../presets/resolve";

/**
 * Renderer-side slot components: the daemon
 * compiles each extension-contributed component module to self-contained
 * ESM JavaScript (react bundled in) and serves the code through
 * `extensions.list`. The GUI dynamically imports it (blob: URL) and mounts
 * the default export into the named slot — enable/disable of the extension
 * takes effect on the next slot refresh.
 *
 * Track ownership: **serves both.** The slot compiler and the load-once cache
 * are keyed by entry path, which is the same identity both tracks use, so a
 * cordis plugin and a legacy extension contribute components through one
 * implementation. `loadExtensionOnce` runs the shared mount pipeline rather than
 * a track-specific loader, which is what keeps a class-shaped plugin loadable
 * here (see the note on that function).
 *
 * Trust model: an enabled extension already executes arbitrary code in the
 * daemon process; rendering its component in the GUI is the same trust
 * domain, not a new escalation.
 */

/** One compiled slot component served to the renderer. */
export interface SlotComponent {
	slot: string;
	extensionId: string;
	label?: string;
	/** Self-contained ESM JavaScript (react bundled in). Empty on compile failure. */
	code: string;
	/** Compile error message (debug only — the renderer renders empty on failure). */
	error?: string;
	/** Component-scoped CSS (extracted from the component's own `import
	 *  "./x.css"` chains; rendered via a <style> tag by the host). */
	css?: string;
	/** Build-time artifact files backing this component. URL delivery hands the
	 *  file to the artifact origin instead of reading it; inline delivery reads
	 *  it once. Never serialized to a client. */
	codeFile?: string;
	cssFile?: string;
	/** List-slot render order (ascending; registration order otherwise). */
	order?: number;
	/** Entry identity within its slot (one dock entry per pill). */
	id?: string;
	availability?: "always" | "on-demand";
	/** conversation.chat.node seat: node kinds (transcriptNodeKind entryKey) this
	 *  renderer owns. No entryKinds -> does not participate in per-kind node
	 *  dispatch. Entry-key analog. */
	entryKinds?: string[];
}

/** One compiled per-tool view served to the renderer (registerToolView —
 *  ). The GUI dispatches by tool name. */
export interface ToolViewItem {
	tool: string;
	extensionId: string;
	label?: string;
	/** Self-contained ESM JavaScript (react bundled in). Empty on compile failure. */
	code: string;
	/** Build-time artifact backing this view (see SlotComponent.codeFile). */
	codeFile?: string;
	cssFile?: string;
	/** Compile error message (the renderer falls back to the generic view). */
	error?: string;
	/** Component-scoped CSS (extracted like slot components). */
	css?: string;
}

/**
 * One widget type contributed by an active extension (registerWidget), for
 * extensions.list `widgets`. The metadata is serialized here — defaults is
 * invoked once — because the GUI registry needs plain data plus a module.
 */
/** One markdown block renderer contributed by an extension: the kind it claims
 *  plus its compiled renderer module. */
export interface MarkdownBlockViewItem {
	kind: string;
	extensionId: string;
	label: string;
	description?: string;
	code: string;
	css?: string;
	error?: string;
}

export interface WidgetViewItem {
	type: string;
	extensionId: string;
	label: string;
	description?: string;
	fields: Array<{
		key: string;
		type: "number" | "string" | "boolean" | "select";
		label?: string;
		options?: readonly string[];
		min?: number;
		max?: number;
		step?: number;
	}>;
	defaults: Record<string, unknown>;
	tone?: string;
	code: string;
	error?: string;
	css?: string;
}

/** One virtual skill declared by an active extension (registerSkill),
 *  merged into the daemon skills.list / extension center. */
export interface ExtensionSkillItem {
	name: string;
	description: string;
	content: string;
	hide?: boolean;
	/** Extension entry path that declared it (identity for _source). */
	extensionPath: string;
}
/** One status-bar segment contributed by an active extension
 *  (registerStatusBarSegment), in the extensions.list wire shape. The segment
 *  renders statically (`label`) in the GUI status bar after the built-in
 *  model/mode/context segments, ordered by `order`. */
export interface StatusBarSegmentItem {
	/** Unique segment id (`statusbar.seg.<id>` slot key). */
	id: string;
	/** Static display label. */
	label: string;
	/** Order among daemon-contributed segments (ascending; registration order otherwise). */
	order?: number;
	/** Forward-compat renderer hint for hosts that register named renderers. */
	renderKey?: string;
	/** Extension entry path that contributed it (identity). */
	extensionPath: string;
}
/** One scrollbar skin contributed by an active extension
 *  (registerScrollbarSkin), in the extensions.list wire shape. The GUI merges
 *  it over its built-in catalog by id; `extensionPath` is the identity used to
 *  drop it when the plugin unloads. */
export interface ScrollbarSkinItem {
	id: string;
	displayName: string;
	base: "gummy" | "pacman";
	colors: { accent: string; track: string; eaten: string };
	size: number;
	pacGlyph?: string | null;
	/** Extension entry path that contributed it (identity). */
	extensionPath: string;
}

/** Raw-extension load cache: entry path → loaded extension (factory runs once
 *  per cache window).
 *
 *  Load-once is the lifecycle contract: a session-less RPC caller (a settings
 *  panel, a status-bar segment collector) must dispatch to the SAME loaded
 *  module instance across calls, exactly the way a live session does. Loading
 *  the entry per call cost seconds (Bun transpiles the module graph) and made
 *  every slot-panel RPC time out. Invalidation is explicit — see
 *  {@link invalidateExtensionLoadCache} — instead of a short TTL, so a panel
 *  refresh never pays the load again while an install/enable/disable still
 *  takes effect immediately. */
const extensionLoadCache = new Map<string, { at: number; extension: Extension }>();

/** Safety net for entries whose invalidation was missed; long enough that a
 *  panel's repeated RPCs reuse the instance. */
const EXTENSION_LOAD_TTL_MS = 30 * 60_000;

/** Drop every cached entry (install / uninstall / enable / disable / HMR). */
export function invalidateExtensionLoadCache(): void {
	extensionLoadCache.clear();
}

/** Drop one entry (its factory or a module in its graph changed). */
export function invalidateExtensionLoad(entryPath: string): void {
	extensionLoadCache.delete(entryPath);
}

/** Compile cache: abs path + mtime → compiled code + extracted css. */
const compileCache = new Map<string, { mtimeMs: number; code: string; css?: string }>();

/**
 * Compiled artifacts survive the daemon that produced them. A cold daemon
 * recompiles every active component before the first `extensions.list` can
 * answer — the desktop composition is 19 components and tens of megabytes —
 * even when nothing behind them changed. Keep the output on disk and
 * revalidate it against the inputs that decide it.
 *
 * `stamp` is the newest mtime across the workspace sources a component can
 * embed, so any app edit invalidates everything that could carry it;
 * over-invalidating costs one recompile, under-invalidating ships stale code.
 * `version` covers the compiler's own inputs — its options and the host-module
 * contract — which a source walk cannot see.
 */
const ARTIFACT_CACHE_VERSION = "1";
const WORKSPACE_STAMP_TTL_MS = 10_000;
const artifactStamps = new Map<string, { at: number; stamp: number }>();

/** Root of the workspace containing `startDir`, when the manifests declare one. */
function findWorkspaceRoot(startDir: string): string | undefined {
	let dir = startDir;
	for (;;) {
		try {
			const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
				workspaces?: unknown;
			};
			if (manifest.workspaces !== undefined) return dir;
		} catch {
			// no readable manifest here — keep climbing
		}
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Every app and package source tree a compiled component can pull in. */
function workspaceSourceRoots(root: string): string[] {
	const roots: string[] = [];
	for (const group of ["apps", "packages"]) {
		const groupDir = path.join(root, group);
		let children: string[];
		try {
			children = readdirSync(groupDir);
		} catch {
			continue;
		}
		for (const child of children) {
			const src = path.join(groupDir, child, "src");
			if (existsSync(src)) roots.push(src);
		}
	}
	return roots;
}

/** Newest mtime under `root`; `node_modules` and VCS metadata never count. */
function newestMtime(root: string): number {
	let stat: Stats;
	try {
		stat = statSync(root);
	} catch {
		return 0;
	}
	if (!stat.isDirectory()) return stat.mtimeMs;
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return stat.mtimeMs;
	}
	let newest = stat.mtimeMs;
	for (const name of entries) {
		if (name === "node_modules" || name === ".git") continue;
		newest = Math.max(newest, newestMtime(path.join(root, name)));
	}
	return newest;
}

/** Newest source mtime that decides `entryPath`'s compiled output. */
export function sourceStamp(entryPath: string): number {
	const dir = path.dirname(entryPath);
	const root = findWorkspaceRoot(dir);
	// One walk per workspace, not per entry: a component set of two dozen entries
	// would otherwise re-walk the same tree two dozen times inside one call.
	const key = root ?? dir;
	const cached = artifactStamps.get(key);
	if (cached && Date.now() - cached.at < WORKSPACE_STAMP_TTL_MS) return cached.stamp;
	const roots = root === undefined ? [dir] : workspaceSourceRoots(root);
	let stamp = 0;
	for (const source of roots) stamp = Math.max(stamp, newestMtime(source));
	artifactStamps.set(key, { at: Date.now(), stamp });
	return stamp;
}

/** One component's on-disk artifact plus the inputs that produced it. */
interface ArtifactCacheRecord {
	version: string;
	bun: string;
	stamp: number;
	entryMtimeMs: number;
	entrySize: number;
	code: string;
	css?: string;
}

function artifactCacheFile(componentPath: string): string {
	const key = Bun.hash(path.resolve(componentPath).replace(/\\/g, "/")).toString(36);
	return path.join(getExtensionArtifactCacheDir(), `${key}.json`);
}

function readArtifactCache(
	componentPath: string,
	stamp: number,
	entry: { mtimeMs: number; size: number },
): { code: string; css?: string } | undefined {
	let record: ArtifactCacheRecord;
	try {
		record = JSON.parse(readFileSync(artifactCacheFile(componentPath), "utf8")) as ArtifactCacheRecord;
	} catch {
		return undefined;
	}
	if (record.version !== ARTIFACT_CACHE_VERSION) return undefined;
	if (record.bun !== Bun.version) return undefined;
	if (record.stamp !== stamp) return undefined;
	if (record.entryMtimeMs !== entry.mtimeMs || record.entrySize !== entry.size) return undefined;
	return { code: record.code, css: record.css };
}

async function writeArtifactCache(componentPath: string, record: ArtifactCacheRecord): Promise<void> {
	const target = artifactCacheFile(componentPath);
	const tmp = `${target}.${process.pid}.tmp`;
	try {
		await mkdir(path.dirname(target), { recursive: true });
		await Bun.write(tmp, JSON.stringify(record));
		await rename(tmp, target);
	} catch (error) {
		// A cache the daemon cannot write is a slow boot, never a failed one.
		logger.warn("extension artifact cache write failed", { componentPath, error: String(error) });
	}
}

// CommonJS is intentional here. Bun's virtual-ESM interop can emit an empty
// exports object for these host-only modules; a direct export preserves both
// default and named imports without bundling a second copy.
const HOST_REACT_MODULE = `module.exports = window.MusePiReact;`;
const HOST_REACT_DOM_MODULE = `module.exports = window.MusePiReactDOM;`;
const HOST_REACT_DOM_CLIENT_MODULE = `module.exports = window.MusePiReactDOMClient;`;
const HOST_JSX_MODULE = `module.exports = window.MusePiReact;`;

/** Namespace for imports resolved through {@link EXTENSION_HOST_MODULES}. */
const HOST_MODULE_NAMESPACE = "musepi-host-module";

const HOST_MODULE_DECLARATIONS: readonly ExtensionHostModuleDeclaration[] = EXTENSION_HOST_MODULES;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternation(parts: readonly string[]): string {
	return parts.length > 0 ? parts.join("|") : "(?!)";
}

const HOST_MODULE_RELATIVE_FILTER = new RegExp(
	// The basename check keeps decoys like `notlib/x` out; the callback then
	// resolves the full identity, including sibling imports inside `lib`
	// (`./x`) and client-core's own relative `../i18n`, through the
	// importer-aware matcher. Specifier basenames participate so a bare entry
	// (`@musepi/client-core/src/i18n`) also lets its relative spelling
	// (`../i18n/index.js`) reach the callback.
	`(?:^|[\\\\/])(?:${alternation(
		HOST_MODULE_DECLARATIONS.flatMap(entry => {
			const candidates = [
				entry.path ? (entry.path.split("/").at(-1) ?? entry.path) : undefined,
				entry.specifier ? (entry.specifier.split("/").at(-1) ?? entry.specifier) : undefined,
			];
			return candidates.filter((candidate): candidate is string => candidate !== undefined).map(escapeRegExp);
		}),
	)})(?:/index)?(?:\\.(?:tsx?|mjs|cjs|js))?$`,
);
const HOST_MODULE_BARE_FILTER = new RegExp(
	`^(?:${alternation(
		HOST_MODULE_DECLARATIONS.flatMap(entry => (entry.specifier ? [escapeRegExp(entry.specifier)] : [])),
	)})$`,
);

/**
 * The table entry may be absent when the renderer predates a newly declared
 * module; failing with the key names the missing contract instead of surfacing
 * a property access on undefined.
 */
function hostModuleContents(key: string): string {
	const keyLiteral = JSON.stringify(key);
	const message = JSON.stringify(`MusePiHostModules is missing "${key}"`);
	return [
		`if (!window.MusePiHostModules?.[${keyLiteral}]) {`,
		`\tthrow new Error(${message});`,
		"}",
		`module.exports = window.MusePiHostModules[${keyLiteral}];`,
	].join("\n");
}

function hostModulesPlugin(): BunPlugin {
	return {
		name: "musepi-host-modules",
		setup(build) {
			build.onResolve({ filter: HOST_MODULE_RELATIVE_FILTER }, args => {
				const key = matchExtensionHostModule(args.path, args.importer);
				return key === undefined ? undefined : { path: key, namespace: HOST_MODULE_NAMESPACE };
			});
			build.onResolve({ filter: HOST_MODULE_BARE_FILTER }, args => {
				const key = matchExtensionHostModule(args.path, args.importer);
				return key === undefined ? undefined : { path: key, namespace: HOST_MODULE_NAMESPACE };
			});
			build.onLoad({ filter: /.*/, namespace: HOST_MODULE_NAMESPACE }, args => ({
				contents: hostModuleContents(args.path),
				loader: "js",
			}));
			build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, args => ({
				path: args.path,
				namespace: "musepi-host-react",
			}));
			build.onLoad({ filter: /.*/, namespace: "musepi-host-react" }, args => {
				// Bare `react-dom` is its own specifier: without it the ternary fell
				// through to the React module, so `import { flushSync } from
				// "react-dom"` (what @tanstack/react-virtual does) compiled to
				// `window.MusePiReact.flushSync` — undefined at runtime, and the
				// exception surfaced the first time a virtualized list measured.
				const contents = args.path.includes("jsx-")
					? HOST_JSX_MODULE
					: args.path === "react-dom" || args.path.startsWith("react-dom/")
						? args.path === "react-dom/client"
							? HOST_REACT_DOM_CLIENT_MODULE
							: HOST_REACT_DOM_MODULE
						: HOST_REACT_MODULE;
				return { contents, loader: "js" };
			});
		},
	};
}

async function loadExtensionOnce(entryPath: string, cwd: string): Promise<Extension | null> {
	const cached = extensionLoadCache.get(entryPath);
	if (cached && Date.now() - cached.at < EXTENSION_LOAD_TTL_MS) return cached.extension;
	// The SAME pipeline the host and session loaders use. This used to call the
	// legacy loader, which is a second reading of what a plugin module is: it
	// treats a function export as a factory and calls it, so a class-shaped plugin
	// that mounted everywhere else threw here — and this is the path an `ext.call`
	// falls back to when the cordis runtime does not recognize the entry, so the
	// symptom was "the plugin's own panel cannot reach it" for a plugin that was
	// running fine.
	const { loadSessionPlugins } = await import("../extensibility/plugins/runtime/session-loader");
	const { EventBus } = await import("../utils/event-bus");
	const result = await loadSessionPlugins([entryPath], cwd, new EventBus());
	const extension = result.extensions[0] ?? null;
	if (extension === null && result.errors.length > 0) {
		logger.warn("extension load for an RPC call failed", { entryPath, errors: result.errors });
	}
	extensionLoadCache.set(entryPath, { at: Date.now(), extension });
	return extension;
}

/**
 * The one build configuration for a compiled component. The daemon's on-demand
 * compile and an app's build-time artifact pass must emit the same module shape,
 * or a prebuilt artifact would behave differently from a freshly compiled one:
 * host modules externalized, and React bound to the host's instance —
 * components reference React through the `React` identifier (never a bare
 * import), and a bundled copy would double-react and null the hooks dispatcher.
 */
/**
 * The build-time artifact files for a component, when a host built them.
 * Returns paths, not bytes: a caller that delivers URLs can hand the file to
 * the artifact origin, so `extensions.list` never reads (or hashes) the whole
 * composition. Validation is the entry's own mtime and size plus the file's
 * presence — see {@link declaredComponents} for why no workspace walk runs here.
 */
/**
 * Slot declarations a host lifted at build time, with their artifact files.
 * When present the daemon assembles the surface straight from build output;
 * without them it has to mount each plugin's module graph, which is the single
 * most expensive step of the first registry call.
 *
 * Freshness is the artifact's own (entry mtime and size, file present), not a
 * workspace walk: the manifest is rewritten by the same build that wrote the
 * files, and a stale `dist` is what the app already refuses to launch with. A
 * full source walk here cost ~600 ms on every cold registry call.
 */
function declaredComponents(entryPath: string):
	| Array<{
			slot: string;
			label?: string;
			codeFile: string;
			cssFile?: string;
			order?: number;
			id?: string;
			availability?: "always" | "on-demand";
			icon?: string;
			keywords?: string[];
	  }>
	| undefined {
	const dir = process.env.MUSEPI_PLUGIN_ARTIFACTS;
	if (!dir) return undefined;
	const manifest = readPrebuiltManifest(dir);
	const rows = manifest.declarations?.[path.resolve(entryPath).replaceAll("\\", "/")];
	if (!rows || rows.length === 0) return undefined;
	const out: Array<{
		slot: string;
		label?: string;
		codeFile: string;
		cssFile?: string;
		order?: number;
		id?: string;
		availability?: "always" | "on-demand";
		icon?: string;
		keywords?: string[];
	}> = [];
	for (const row of rows) {
		const codeFile = path.join(dir, row.file);
		if (!existsSync(codeFile)) return undefined;
		const cssFile = row.css === undefined ? undefined : path.join(dir, row.css);
		if (cssFile !== undefined && !existsSync(cssFile)) return undefined;
		// The manifest is build output, but the daemon only ever saw it as JSON:
		// an unrecognised availability word must fall back to the load path's
		// meaning (a launchable tab) rather than reach the rail filter as junk.
		const availability =
			row.availability === "always" || row.availability === "on-demand" ? row.availability : undefined;
		out.push({
			slot: row.slot,
			...(row.label ? { label: row.label } : {}),
			codeFile,
			...(cssFile ? { cssFile } : {}),
			...(row.order !== undefined ? { order: row.order } : {}),
			...(row.id ? { id: row.id } : {}),
			...(availability ? { availability } : {}),
		});
	}
	return out;
}

/**
 * Whether the build says a plugin declares a given optional surface. `true` or
 * `undefined` keeps the load path (unknown means "cannot tell"); only an
 * explicit `false` skips it, which is what removes a module-graph load per
 * plugin from the collectors that would otherwise enumerate an empty set.
 */
function declaredSurface(
	entryPath: string,
	kind: "toolViews" | "widgets" | "statusBar" | "skins",
): boolean | undefined {
	const dir = process.env.MUSEPI_PLUGIN_ARTIFACTS;
	if (!dir) return undefined;
	const surfaces = readPrebuiltManifest(dir).surfaces;
	if (surfaces === undefined) return undefined;
	const row = surfaces[path.resolve(entryPath).replaceAll("\\", "/")];
	return row?.[kind];
}

export function prebuiltArtifactFiles(componentPath: string): { codeFile: string; cssFile?: string } | undefined {
	const dir = process.env.MUSEPI_PLUGIN_ARTIFACTS;
	if (!dir) return undefined;
	let entry: { mtimeMs: number; size: number };
	try {
		const info = statSync(componentPath);
		entry = { mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		return undefined;
	}
	const manifest = readPrebuiltManifest(dir);
	const record = manifest.entries?.[path.resolve(componentPath).replaceAll("\\", "/")];
	if (!record) return undefined;
	if (record.mtimeMs !== entry.mtimeMs || record.size !== entry.size) return undefined;
	const codeFile = path.join(dir, record.file);
	if (!existsSync(codeFile)) return undefined;
	const cssFile = record.css === undefined ? undefined : path.join(dir, record.css);
	return cssFile === undefined || existsSync(cssFile) ? { codeFile, ...(cssFile ? { cssFile } : {}) } : { codeFile };
}

export function componentBuildConfig(entrypoints: string[]): Bun.BuildConfig {
	return {
		entrypoints,
		format: "esm",
		target: "browser",
		minify: true,
		sourcemap: "none",
		plugins: [hostModulesPlugin()],
		jsx: {
			runtime: "classic",
			factory: "window.MusePiReact.createElement",
			fragment: "window.MusePiReact.Fragment",
		},
		define: {
			React: "window.MusePiReact",
			"process.env.NODE_ENV": '"production"',
		},
	} satisfies Bun.BuildConfig;
}

/**
 * A host that compiled its own plugins during its build publishes the result
 * here (`MUSEPI_PLUGIN_ARTIFACTS` → a directory with `manifest.json`). The
 * daemon then serves that artifact instead of compiling again, and the artifact
 * shares the host's build graph rather than duplicating it at every boot.
 * Validation is the same pair the disk cache uses: the entry's own mtime/size
 * and the workspace stamp at build time.
 */
interface PrebuiltManifest {
	stamp?: number;
	entries?: Record<string, { file: string; css?: string; mtimeMs: number; size: number }>;
	/** Slot declarations per plugin entry module, lifted at build time. */
	declarations?: Record<
		string,
		Array<{
			slot: string;
			file: string;
			css?: string;
			label?: string;
			order?: number;
			/** Entry identity within the slot (one dock entry per pill). */
			id?: string;
			/** Written by the host's build; validated on read, never trusted raw. */
			availability?: string;
			/** Settings-page nav glyph / search keywords (owner options). */
			icon?: string;
			keywords?: string[];
		}>
	>;
	/** What each plugin declares, so a collector can skip a plugin with none. */
	surfaces?: Record<string, { toolViews?: boolean; widgets?: boolean; statusBar?: boolean; skins?: boolean }>;
}

let prebuiltCache: { at: number; dir: string; manifest: PrebuiltManifest } | undefined;

/** The manifest, re-read at most every two seconds so a rebuild lands without
 *  a daemon restart while a burst of components still shares one read. */
function readPrebuiltManifest(dir: string): PrebuiltManifest {
	const now = Date.now();
	if (!prebuiltCache || prebuiltCache.dir !== dir || now - prebuiltCache.at > 2_000) {
		let manifest: PrebuiltManifest = {};
		try {
			manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as PrebuiltManifest;
		} catch {
			// No build-time pass ran for this host — compile on demand as before.
		}
		prebuiltCache = { at: now, dir, manifest };
	}
	return prebuiltCache.manifest;
}

function readPrebuiltArtifact(
	componentPath: string,
	stamp: number,
	entry: { mtimeMs: number; size: number },
): { code: string; css?: string } | undefined {
	const dir = process.env.MUSEPI_PLUGIN_ARTIFACTS;
	if (!dir) return undefined;
	const now = Date.now();
	if (!prebuiltCache || prebuiltCache.dir !== dir || now - prebuiltCache.at > 2_000) {
		let manifest: PrebuiltManifest = {};
		try {
			manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as PrebuiltManifest;
		} catch {
			// No build-time pass ran for this host — compile on demand as before.
		}
		prebuiltCache = { at: now, dir, manifest };
	}
	const record = prebuiltCache.manifest.entries?.[path.resolve(componentPath).replace(/\\/g, "/")];
	if (!record) return undefined;
	if (prebuiltCache.manifest.stamp !== stamp) return undefined;
	if (record.mtimeMs !== entry.mtimeMs || record.size !== entry.size) return undefined;
	try {
		const code = readFileSync(path.join(dir, record.file), "utf8");
		const css = record.css ? readFileSync(path.join(dir, record.css), "utf8") : undefined;
		return css ? { code, css } : { code };
	} catch {
		return undefined;
	}
}

export async function compileComponentModule(componentPath: string): Promise<{ code: string; css?: string }> {
	let entry: { mtimeMs: number; size: number } | undefined;
	try {
		const info = await Bun.file(componentPath).stat();
		entry = { mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		// Path vanished — fall through to a fresh compile attempt.
	}
	const cached = compileCache.get(componentPath);
	if (cached && entry !== undefined && cached.mtimeMs === entry.mtimeMs) {
		return { code: cached.code, css: cached.css };
	}
	// Revalidated against the sources that decide the output, so a daemon that
	// just started serves what the previous one compiled instead of rebuilding
	// the whole plugin composition.
	const stamp = sourceStamp(componentPath);
	if (entry !== undefined) {
		const built = readPrebuiltArtifact(componentPath, stamp, entry);
		if (built) {
			compileCache.set(componentPath, { mtimeMs: entry.mtimeMs, code: built.code, css: built.css });
			return built;
		}
		const stored = readArtifactCache(componentPath, stamp, entry);
		if (stored) {
			compileCache.set(componentPath, { mtimeMs: entry.mtimeMs, code: stored.code, css: stored.css });
			return { code: stored.code, css: stored.css };
		}
	}

	const result = await Bun.build(componentBuildConfig([componentPath]));
	const output = result.outputs[0];
	if (!output) {
		throw new Error(result.logs.map(l => l.message).join("; ") || "no output");
	}
	const code = await output.text();
	// Component-scoped CSS: the component's `import "./x.css"` chains are
	// extracted by bun.build into a separate css output — carry it alongside
	// the code so the host can inject a <style> (previously dropped, so
	// component styling was silently lost).
	let css: string | undefined;
	const cssOutput = result.outputs.find(o => o.path.endsWith(".css"));
	if (cssOutput) {
		const text = await cssOutput.text();
		if (text.trim().length > 0) css = text;
	}
	// Release-staged components are already bundled JavaScript. Their extracted
	// companion stylesheet must survive the second, no-op compilation pass.
	if (!css && componentPath.endsWith(".js")) {
		const companion = componentPath.replace(/\.js$/, ".css");
		if (await Bun.file(companion).exists()) css = await Bun.file(companion).text();
	}
	if (entry !== undefined) {
		compileCache.set(componentPath, { mtimeMs: entry.mtimeMs, code, css });
		await writeArtifactCache(componentPath, {
			version: ARTIFACT_CACHE_VERSION,
			bun: Bun.version,
			stamp,
			entryMtimeMs: entry.mtimeMs,
			entrySize: entry.size,
			code,
			css,
		});
	}
	return { code, css };
}

/**
 * Collect compiled slot components from the unified extension list
 * (extensions.list shape): only active extension-module entries contribute,
 * matched by entry path. The raw factory runs once per 10s window, so a
 * repeated list call never double-registers tools/handlers.
 */
export async function collectSlotComponents(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<SlotComponent[]> {
	const out: SlotComponent[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		// A host that lifted slot declarations at build time answers here without
		// mounting the plugin: loading every plugin's module graph just to learn
		// which slots it declares was the single most expensive step of the first
		// registry call (measured ~2 s for the desktop composition).
		const declared = declaredComponents(entry.path);
		if (declared) {
			for (const row of declared) {
				out.push({
					slot: row.slot,
					extensionId: entry.path,
					...(row.label ? { label: row.label } : {}),
					code: "",
					codeFile: row.codeFile,
					...(row.cssFile ? { cssFile: row.cssFile } : {}),
					...(row.order !== undefined ? { order: row.order } : {}),
					...(row.id ? { id: row.id } : {}),
					...(row.availability ? { availability: row.availability } : {}),
					...(row.icon ? { icon: row.icon } : {}),
					...(row.keywords && row.keywords.length > 0 ? { keywords: row.keywords } : {}),
				});
			}
			continue;
		}
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const component of extension.components ?? []) {
			const absPath = path.resolve(extension.resolvedPath, "..", component.moduleUrl);
			try {
				// A host-built artifact is delivered as a file: reading it here would
				// move the whole composition through the daemon for no reason.
				const built = prebuiltArtifactFiles(absPath);
				if (built) {
					out.push({
						slot: component.slot,
						extensionId: extension.path,
						label: component.label,
						code: "",
						codeFile: built.codeFile,
						...(built.cssFile ? { cssFile: built.cssFile } : {}),
						...(component.order !== undefined ? { order: component.order } : {}),
						...(component.id ? { id: component.id } : {}),
						...(component.availability ? { availability: component.availability } : {}),
						...(component.entryKinds && component.entryKinds.length > 0
							? { entryKinds: component.entryKinds }
							: {}),
						...(component.icon ? { icon: component.icon } : {}),
						...(component.keywords && component.keywords.length > 0 ? { keywords: component.keywords } : {}),
					});
					continue;
				}
				const compiled = await compileComponentModule(absPath);
				out.push({
					slot: component.slot,
					extensionId: extension.path,
					label: component.label,
					code: compiled.code,
					...(compiled.css ? { css: compiled.css } : {}),
					...(component.order !== undefined ? { order: component.order } : {}),
					...(component.id ? { id: component.id } : {}),
					...(component.availability ? { availability: component.availability } : {}),
					...(component.entryKinds && component.entryKinds.length > 0 ? { entryKinds: component.entryKinds } : {}),
					...(component.icon ? { icon: component.icon } : {}),
					...(component.keywords && component.keywords.length > 0 ? { keywords: component.keywords } : {}),
				});
			} catch (error) {
				// A broken component must not fail the whole extensions.list —
				// the renderer shows the slot as empty until fixed.
				out.push({
					slot: component.slot,
					extensionId: extension.path,
					label: component.label ?? component.moduleUrl,
					code: "",
					error: String(error),
					...(component.order !== undefined ? { order: component.order } : {}),
					...(component.id ? { id: component.id } : {}),
					...(component.availability ? { availability: component.availability } : {}),
					...(component.icon ? { icon: component.icon } : {}),
					...(component.keywords && component.keywords.length > 0 ? { keywords: component.keywords } : {}),
				});
			}
		}
	}
	return out;
}

/** Drop the load-once + compile caches — called by the daemon's extension
 *  watcher (HMR) when extension source/config files change, so the next
 *  extensions.list serves freshly compiled components. */
export function invalidateExtensionCaches(): void {
	extensionLoadCache.clear();
	compileCache.clear();
	// Source edits are what invalidate the on-disk artifacts; dropping the
	// memo makes the next lookup re-walk the tree instead of trusting a stamp
	// taken before the change.
	artifactStamps.clear();
}

/**
 * 校验扩展的槽位组件能否编译(extension_validate 工具 /modes validate
 * 挂载校验用):不注册、不改缓存,只试编译每个组件模块。
 * 返回 { moduleUrl, error }[];空数组 = 全部可编译。
 */
export async function validateExtensionComponents(
	extension: Pick<Extension, "resolvedPath" | "components">,
): Promise<Array<{ moduleUrl: string; error: string }>> {
	const out: Array<{ moduleUrl: string; error: string }> = [];
	for (const component of extension.components ?? []) {
		const absPath = path.resolve(extension.resolvedPath, "..", component.moduleUrl);
		try {
			await compileComponentModule(absPath);
		} catch (error) {
			out.push({ moduleUrl: component.moduleUrl, error: String(error) });
		}
	}
	return out;
}

/** A preset declared by an extension (registerMode, modes v2 §5.5) in the
 *  modes.list wire shape; `source: "extension"` distinguishes it from
 *  file-based presets so the GUI can show the provider. */
export interface ExtensionModeItem {
	id: string;
	builtin: false;
	label?: string;
	description?: string;
	extends: [];
	extensions?: string[];
	hasPrompt: boolean;
	promptComplete: boolean;
	settingsKeys: string[];
	/** Composition declared by the extension, same shape as a file preset's. */
	plugins: PresetPluginRow[];
	source: "extension";
}

/**
 * Collect presets declared by active extension-module entries (registerMode),
 * for modes.list merging. Id collisions with file-based presets are resolved
 * by the caller (file wins — user data layer beats extension code layer).
 * Shares the 10s load-once cache with collectSlotComponents, so a repeated
 * list call never re-runs extension factories.
 */
export async function collectExtensionModes(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<ExtensionModeItem[]> {
	const out: ExtensionModeItem[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		// 单模式防御:畸形 mode 项(缺 id/类型错)只跳过该模式,不影响
		// 同扩展其余模式与整个 modes.list —— 扩展代码层故障不拖垮 UI。
		for (const mode of extension.modes ?? []) {
			try {
				if (!mode || typeof mode.id !== "string" || mode.id.length === 0) continue;
				out.push({
					id: mode.id,
					builtin: false,
					label: mode.label,
					description: mode.description,
					extends: [],
					extensions: mode.extensions,
					hasPrompt: (mode.prompt?.length ?? 0) > 0,
					promptComplete: mode.promptComplete === true,
					settingsKeys: Object.keys(mode.settings ?? {}),
					plugins: mode.plugins ?? [],
					source: "extension",
				});
			} catch (err) {
				console.warn(`extension mode skipped (${mode?.id ?? "<unknown>"}):`, err);
			}
		}
	}
	return out;
}

/**
 * Invoke a daemon-side JSON-RPC method registered by an extension
 * (registerRpc). Unknown methods throw so the daemon surfaces a JSON-RPC error
 * to the GUI caller.
 *
 * Dispatch prefers a CORDIS-MANAGED instance when the host registered a lookup
 * for it. That matters for correctness, not just efficiency: plugin entries are
 * loaded through `loadLegacyPiModule`, which stamps every load with
 * `?mtime=<tag>` so Bun rekeys the module (the mechanism HMR depends on). Two
 * loaders therefore produce TWO module instances, and module-level state written
 * by one is invisible to the other — a plugin that captures the session context
 * on the session instance would have its `ext.call` handler (different instance)
 * see `null`.
 *
 * Registering the resolver from the daemon (which owns the cordis runtime) keeps
 * one instance for both faces. When no resolver is registered — a bare
 * extension file, a test, a host without the runtime — this falls back to the
 * artifact-compiler cache, which stays correct for RPCs that hold no module
 * state.
 */
let rpcDispatcher: ExtensionRpcDispatcher | null = null;

/** Route an RPC to the host's own (cordis-managed) extension instance. */
export type ExtensionRpcDispatcher = (
	entryPath: string,
	method: string,
	params: unknown,
	ctx: { cwd: string; sessionId?: string },
) => Promise<{ found: false } | { found: true; value: unknown }>;

/** Install the host's dispatcher (called once by the daemon at boot). */
export function setExtensionRpcDispatcher(dispatcher: ExtensionRpcDispatcher | null): void {
	rpcDispatcher = dispatcher;
}

export async function invokeExtensionRpc(
	entryPath: string,
	cwd: string,
	method: string,
	params: unknown,
	ctx: { cwd: string; sessionId?: string },
): Promise<unknown> {
	if (rpcDispatcher !== null) {
		const routed = await rpcDispatcher(entryPath, method, params, ctx);
		if (routed.found) return routed.value;
	}
	const extension = await loadExtensionOnce(entryPath, cwd);
	if (!extension) throw new Error(`extension not loadable: ${entryPath}`);
	const handler = extension.rpcs.get(method);
	if (!handler) throw new Error(`unknown extension rpc method "${method}" (extension ${entryPath})`);
	return await handler(params, ctx);
}

/**
 * Collect virtual skills declared by active extension-module entries
 * (registerSkill), for merging into
 * the daemon skills.list / extension center alongside file-discovered
 * skills. Shares the 10s load-once cache.
 */
export async function collectExtensionSkills(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<ExtensionSkillItem[]> {
	const out: ExtensionSkillItem[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const skill of extension.skills ?? []) {
			try {
				if (!skill || typeof skill.name !== "string" || skill.name.length === 0) continue;
				out.push({
					name: skill.name,
					description: skill.description ?? "",
					content: skill.content ?? "",
					...(skill.hide !== undefined ? { hide: skill.hide } : {}),
					extensionPath: entry.path,
				});
			} catch (err) {
				console.warn(`extension skill skipped (${skill?.name ?? "<unknown>"}):`, err);
			}
		}
	}
	return out;
}

/**
 * Collect compiled per-tool views declared by active extension-module
 * entries (registerToolView), for
 * extensions.list `toolViews`. A broken view does not fail the whole list —
 * it carries `error` and the renderer falls back to the generic view.
 */
/**
 * Collect status-bar segments declared by active extension-module entries
 * (registerStatusBarSegment), for extensions.list `statusBarSegments`.
 * Shares the 10s load-once cache so a repeated list call never re-runs
 * extension factories. A malformed segment (missing id/label) is skipped —
 * extension code faults must not break the whole status bar.
 */
export async function collectStatusBarSegments(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<StatusBarSegmentItem[]> {
	const out: StatusBarSegmentItem[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		if (declaredSurface(entry.path, "statusBar") === false) continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const seg of extension.statusBarSegments ?? []) {
			try {
				if (!seg || typeof seg.id !== "string" || seg.id.length === 0) continue;
				if (typeof seg.label !== "string" || seg.label.length === 0) continue;
				out.push({
					id: seg.id,
					label: seg.label,
					...(seg.order !== undefined ? { order: seg.order } : {}),
					...(seg.renderKey !== undefined ? { renderKey: seg.renderKey } : {}),
					extensionPath: entry.path,
				});
			} catch (err) {
				console.warn(`extension status-bar segment skipped (${seg?.id ?? "<unknown>"}):`, err);
			}
		}
	}
	return out;
}

/**
 * Collect scrollbar skins declared by active extension-module entries
 * (registerScrollbarSkin), for extensions.list `scrollbarSkins`. Shares the
 * load-once cache; a malformed skin is skipped so one bad theme bundle cannot
 * take the skin catalog down with it.
 */
export async function collectScrollbarSkins(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<ScrollbarSkinItem[]> {
	const out: ScrollbarSkinItem[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		if (declaredSurface(entry.path, "skins") === false) continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const skin of extension.scrollbarSkins ?? []) {
			try {
				if (!skin || typeof skin.id !== "string" || skin.id.length === 0) continue;
				if (typeof skin.displayName !== "string" || skin.displayName.length === 0) continue;
				if (skin.base !== "gummy" && skin.base !== "pacman") continue;
				if (!skin.colors || typeof skin.colors.accent !== "string") continue;
				out.push({
					id: skin.id,
					displayName: skin.displayName,
					base: skin.base,
					colors: skin.colors,
					size: skin.size,
					...(skin.pacGlyph ? { pacGlyph: skin.pacGlyph } : {}),
					extensionPath: entry.path,
				});
			} catch (err) {
				console.warn(`extension scrollbar skin skipped (${skin?.id ?? "<unknown>"}):`, err);
			}
		}
	}
	return out;
}

export async function collectToolViews(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<ToolViewItem[]> {
	const out: ToolViewItem[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		if (declaredSurface(entry.path, "toolViews") === false) continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const view of extension.toolViews ?? []) {
			const absPath = path.resolve(extension.resolvedPath, "..", view.moduleUrl);
			try {
				const compiled = await compileComponentModule(absPath);
				out.push({
					tool: view.tool,
					extensionId: extension.path,
					label: view.label,
					code: compiled.code,
					...(compiled.css ? { css: compiled.css } : {}),
				});
			} catch (error) {
				out.push({
					tool: view.tool,
					extensionId: extension.path,
					label: view.label ?? view.moduleUrl,
					code: "",
					error: String(error),
				});
			}
		}
	}
	return out;
}

/**
 * Collect widget types declared by active extension-module entries
 * (registerWidget), for extensions.list `widgets`.
 *
 * Metadata and renderer travel together so the GUI can register a working
 * type from one item. A broken module still ships the metadata with `error`
 * set — the type stays valid for agents and the board, and the renderer shows
 * the standard unavailable card instead of the type vanishing.
 */
/**
 * Compile markdown block renderers contributed by extensions
 * (`registerMarkdownBlock`) — same contract as `collectWidgetViews`: the
 * module is compiled once here and imported by the GUI's block registry, so a
 * plugin can replace `table` or introduce a kind of its own.
 */
export async function collectMarkdownBlockViews(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<MarkdownBlockViewItem[]> {
	const out: MarkdownBlockViewItem[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const block of extension.markdownBlocks ?? []) {
			const meta = {
				kind: block.kind,
				extensionId: extension.path,
				label: block.label,
				...(block.description ? { description: block.description } : {}),
			};
			const absPath = path.resolve(extension.resolvedPath, "..", block.moduleUrl);
			try {
				const compiled = await compileComponentModule(absPath);
				out.push({ ...meta, code: compiled.code, ...(compiled.css ? { css: compiled.css } : {}) });
			} catch (error) {
				out.push({ ...meta, code: "", error: String(error) });
			}
		}
	}
	return out;
}

export async function collectWidgetViews(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<WidgetViewItem[]> {
	const out: WidgetViewItem[] = [];
	for (const entry of extensions) {
		if (
			(entry.kind !== LEGACY_EXTENSION_MODULE_KIND && entry.kind !== PLUGIN_MODULE_KIND) ||
			entry.state !== "active"
		)
			continue;
		if (declaredSurface(entry.path, "widgets") === false) continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const widget of extension.widgets ?? []) {
			const absPath = path.resolve(extension.resolvedPath, "..", widget.moduleUrl);
			let defaults: Record<string, unknown> = {};
			try {
				const value = widget.defaults();
				if (value && typeof value === "object" && !Array.isArray(value)) {
					defaults = value as Record<string, unknown>;
				}
			} catch {
				defaults = {};
			}
			const meta = {
				type: widget.type,
				extensionId: extension.path,
				label: widget.label,
				...(widget.description ? { description: widget.description } : {}),
				fields: widget.fields,
				defaults,
				...(widget.tone ? { tone: widget.tone } : {}),
			};
			try {
				const compiled = await compileComponentModule(absPath);
				out.push({
					...meta,
					code: compiled.code,
					...(compiled.css ? { css: compiled.css } : {}),
				});
			} catch (error) {
				out.push({ ...meta, code: "", error: String(error) });
			}
		}
	}
	return out;
}
