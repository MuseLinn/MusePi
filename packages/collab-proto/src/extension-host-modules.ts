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
 * Resolve an import request to a host module key.
 *
 * Relative requests match by path suffix because a plugin may sit at any
 * directory depth (`../lib/x`, `../../lib/x`). A sibling import from another
 * module inside `lib` (`./x`) is the same module identity, so it resolves to
 * the `lib/x` entry when the importer lives under a `lib` directory. Bare
 * requests match exactly. Returns undefined when the import stays bundled.
 */
export function matchExtensionHostModule(request: string, importer?: string): ExtensionHostModuleKey | undefined {
	const normalized = normalize(request);
	// A relative `../i18n` is only the shared module when the importer lives
	// inside client-core: another package's `../i18n` is a different module
	// and must keep its own copy.
	if (
		normalized.endsWith(CLIENT_CORE_I18N_SUFFIX) &&
		importer !== undefined &&
		normalize(importer).includes(CLIENT_CORE_SRC_SEGMENT)
	) {
		return CLIENT_CORE_I18N_KEY;
	}
	const candidates = [normalized];
	if (normalized.startsWith("./") && importer !== undefined && normalize(importer).includes("/lib/")) {
		candidates.push(`lib/${normalized.slice(2)}`);
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
