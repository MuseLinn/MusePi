/**
 * Frozen host module table for compiled extension components.
 *
 * A compiled component is a standalone ESM bundle: anything imported from the
 * app would otherwise be copied into that bundle. Copies are harmless for pure
 * helpers, but React context and module-level state must be ONE instance across
 * the shell and every plugin — a second copy reads its own default context (a
 * plugin's confirm silently resolves `false`), subscribes to its own toast
 * store, or owns a second floating-menu mutex.
 *
 * The compiler resolves a matching import to `window.MusePiHostModules[key]`
 * instead of bundling it. Add an entry here only when identity must be shared;
 * pure helpers stay bundled. `path` matches a relative app import by normalized
 * suffix (`../lib/action-toast`), `specifier` matches an exact bare import.
 */
export interface ExtensionHostModuleDeclaration {
	/** Key in `window.MusePiHostModules`. */
	readonly key: string;
	/** Relative app module path, without extension. */
	readonly path?: string;
	/** Exact bare package specifier. */
	readonly specifier?: string;
}

/**
 * Single authority for compiler externals and the renderer's exposed table.
 * Keep the list minimal: every entry is a module whose identity the host
 * promises to every compiled plugin.
 */
export const EXTENSION_HOST_MODULES = [
	{ key: "prompt-dialog", path: "lib/prompt-dialog" },
	{ key: "managed-browser-host", path: "lib/managed-browser-host" },
	{ key: "action-toast", path: "lib/action-toast" },
	{ key: "file-workspace", path: "lib/file-workspace" },
	{ key: "floating-menu", path: "lib/use-floating-menu" },
	{ key: "update-ux", path: "lib/update-ux" },
	{ key: "tooltips", path: "lib/tooltips" },
	{ key: "slot-host", path: "lib/slot-host" },
	{ key: "monaco-runtime", path: "lib/monaco-runtime" },
	{ key: "monaco-lsp", path: "lib/monaco-lsp" },
	{ key: "voice", path: "lib/voice" },
	{ key: "panel-maximize", path: "lib/panel-maximize" },
	{ key: "suggestions", path: "lib/suggestions" },
	/** Shared scrollbar-skin registry: the overlay may run inside a compiled
	 *  plugin bundle, and it must read the SAME contributed/imported catalog
	 *  the appearance picker writes. */
	{ key: "scrollbar-skins", path: "plugins/ui-theme/skins" },
	/** Shared task-center nav store: a compiled sidebar panel must read the
	 *  SAME snapshot the page publishes, not a bundled copy of the store. */
	{ key: "task-nav", path: "lib/scheduled-task-nav" },
	/** Shared capability-center nav store: the compiled app.capability page
	 *  publishes the tab/counts and the compiled sidebar.panel.capability
	 *  panel reads them; both must bind the ONE host instance. */
	{ key: "capability-nav", path: "lib/capability-nav" },
	{ key: "client-core", specifier: "@musepi/client-core" },
	{ key: "i18n", specifier: "@musepi/client-core/src/i18n" },
] as const satisfies readonly ExtensionHostModuleDeclaration[];

/** One table key. */
export type ExtensionHostModuleKey = (typeof EXTENSION_HOST_MODULES)[number]["key"];

const MODULE_EXTENSION = /\.(?:tsx?|m?js|cjs)$/;

/** client-core sources reach their own i18n through relative imports, so the
 *  importer's location is what establishes identity. */
const CLIENT_CORE_I18N_KEY = "i18n";
const CLIENT_CORE_I18N_SUFFIX = "/i18n";
const CLIENT_CORE_SRC_SEGMENT = "/client-core/src/";

function normalize(request: string): string {
	const path = request.split(/[?#]/)[0] ?? request;
	return path
		.replace(/\\/g, "/")
		.replace(MODULE_EXTENSION, "")
		.replace(/\/index$/, "")
		.replace(/\/+$/, "");
}

/**
 * Collapse `.` / `..` segments in an app-relative path (no Node `path` here:
 * this module is shared with the renderer bundle).
 */
function collapseSegments(value: string): string {
	const out: string[] = [];
	for (const segment of value.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") out.pop();
		else out.push(segment);
	}
	return out.join("/");
}

/**
 * Resolve an import request to a host module key.
 *
 * Relative requests match by path suffix because a plugin may sit at any
 * directory depth (`../lib/x`, `../../lib/x`). A sibling import from another
 * module inside `lib` (`./x`) is the same module identity, so it resolves to
 * the `lib/x` entry when the importer lives under a `lib` directory; any other
 * sibling import resolves against the importer's directory so a bundle can
 * own a shared module in its own folder (`ui-theme/rail.tsx` → `./skins`).
 * Bare requests match exactly. Returns undefined when the import stays bundled.
 */
export function matchExtensionHostModule(request: string, importer?: string): ExtensionHostModuleKey | undefined {
	const normalized = normalize(request);
	const normalizedImporter = importer === undefined ? undefined : normalize(importer);
	// A relative `../i18n` is only the shared module when the importer lives
	// inside client-core: another package's `../i18n` is a different module
	// and must keep its own copy.
	if (normalized.endsWith(CLIENT_CORE_I18N_SUFFIX) && normalizedImporter?.includes(CLIENT_CORE_SRC_SEGMENT)) {
		return CLIENT_CORE_I18N_KEY;
	}
	const candidates = [normalized];
	if (normalized.startsWith("./") && normalizedImporter?.includes("/lib/")) {
		candidates.push(`lib/${normalized.slice(2)}`);
	}
	if (normalized.startsWith(".") && normalizedImporter !== undefined) {
		const dir = normalizedImporter.slice(0, normalizedImporter.lastIndexOf("/"));
		if (dir.length > 0) candidates.push(collapseSegments(`${dir}/${normalized}`));
	}
	for (const entry of EXTENSION_HOST_MODULES) {
		if ("specifier" in entry && entry.specifier !== undefined) {
			if (normalized === entry.specifier) return entry.key;
			continue;
		}
		const path = (entry as { path?: string }).path;
		if (path === undefined) continue;
		if (candidates.some(candidate => candidate === path || candidate.endsWith(`/${path}`))) return entry.key;
	}
	return undefined;
}
