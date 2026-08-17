import * as path from "node:path";
import { loadExtensions } from "../extensibility/extensions/loader";
import type { Extension } from "../extensibility/extensions/types";

/**
 * Renderer-side slot components (DSH ui-slots analogue): the daemon
 * compiles each extension-contributed component module to self-contained
 * ESM JavaScript (react bundled in) and serves the code through
 * `extensions.list`. The GUI dynamically imports it (blob: URL) and mounts
 * the default export into the named slot — enable/disable of the extension
 * takes effect on the next slot refresh.
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
}

/** Raw-extension load cache: entry path → loaded extension (factory runs once per TTL window). */
const extensionLoadCache = new Map<string, { at: number; extension: Extension }>();

/** Compile cache: abs path + mtime → compiled code. */
const compileCache = new Map<string, { mtimeMs: number; code: string }>();

async function loadExtensionOnce(entryPath: string, cwd: string): Promise<Extension | null> {
	const cached = extensionLoadCache.get(entryPath);
	if (cached && Date.now() - cached.at < 10_000) return cached.extension;
	const result = await loadExtensions([entryPath], cwd);
	const extension = result.extensions[0] ?? null;
	extensionLoadCache.set(entryPath, { at: Date.now(), extension });
	return extension;
}

async function compileComponentModule(componentPath: string): Promise<string> {
	let mtimeMs: number | undefined;
	try {
		mtimeMs = (await Bun.file(componentPath).stat()).mtimeMs;
	} catch {
		// Path vanished — fall through to a fresh compile attempt.
	}
	const cached = compileCache.get(componentPath);
	if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) return cached.code;

	const result = await Bun.build({
		entrypoints: [componentPath],
		format: "esm",
		target: "browser",
		minify: true,
		sourcemap: "none",
		// Components reference React through the `React` identifier (never
		// bare-import it): the renderer injects window.MusePiReact before
		// mounting, so the compiled module uses the HOST's react instance —
		// a bundled copy would double-react and null the hooks dispatcher.
		jsx: {
			runtime: "classic",
			factory: "window.MusePiReact.createElement",
			fragment: "window.MusePiReact.Fragment",
		},
		define: {
			React: "window.MusePiReact",
			"process.env.NODE_ENV": '"production"',
		},
	});
	const output = result.outputs[0];
	if (!output) {
		throw new Error(result.logs.map(l => l.message).join("; ") || "no output");
	}
	const code = await output.text();
	if (mtimeMs !== undefined) compileCache.set(componentPath, { mtimeMs, code });
	return code;
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
		if (entry.kind !== "extension-module" || entry.state !== "active") continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const component of extension.components ?? []) {
			const absPath = path.resolve(extension.resolvedPath, "..", component.moduleUrl);
			try {
				const code = await compileComponentModule(absPath);
				out.push({
					slot: component.slot,
					extensionId: extension.path,
					label: component.label,
					code,
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
		if (entry.kind !== "extension-module" || entry.state !== "active") continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const mode of extension.modes ?? []) {
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
				source: "extension",
			});
		}
	}
	return out;
}
