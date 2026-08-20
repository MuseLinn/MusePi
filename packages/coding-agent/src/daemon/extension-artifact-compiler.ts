import * as path from "node:path";
import { loadExtensions } from "../extensibility/extensions/loader";
import type { Extension } from "../extensibility/extensions/types";

/**
 * Renderer-side slot components: the daemon
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
	/** Component-scoped CSS (extracted from the component's own `import
	 *  "./x.css"` chains; rendered via a <style> tag by the host). */
	css?: string;
	/** List-slot render order (ascending; registration order otherwise). */
	order?: number;
}

/** One compiled per-tool view served to the renderer (registerToolView —
 *  ). The GUI dispatches by tool name. */
export interface ToolViewItem {
	tool: string;
	extensionId: string;
	label?: string;
	/** Self-contained ESM JavaScript (react bundled in). Empty on compile failure. */
	code: string;
	/** Compile error message (the renderer falls back to the generic view). */
	error?: string;
	/** Component-scoped CSS (extracted like slot components). */
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

/** Raw-extension load cache: entry path → loaded extension (factory runs once per TTL window). */
const extensionLoadCache = new Map<string, { at: number; extension: Extension }>();

/** Compile cache: abs path + mtime → compiled code + extracted css. */
const compileCache = new Map<string, { mtimeMs: number; code: string; css?: string }>();

async function loadExtensionOnce(entryPath: string, cwd: string): Promise<Extension | null> {
	const cached = extensionLoadCache.get(entryPath);
	if (cached && Date.now() - cached.at < 10_000) return cached.extension;
	const result = await loadExtensions([entryPath], cwd);
	const extension = result.extensions[0] ?? null;
	extensionLoadCache.set(entryPath, { at: Date.now(), extension });
	return extension;
}

async function compileComponentModule(componentPath: string): Promise<{ code: string; css?: string }> {
	let mtimeMs: number | undefined;
	try {
		mtimeMs = (await Bun.file(componentPath).stat()).mtimeMs;
	} catch {
		// Path vanished — fall through to a fresh compile attempt.
	}
	const cached = compileCache.get(componentPath);
	if (cached && mtimeMs !== undefined && cached.mtimeMs === mtimeMs) {
		return { code: cached.code, css: cached.css };
	}

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
	if (mtimeMs !== undefined) compileCache.set(componentPath, { mtimeMs, code, css });
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
		if (entry.kind !== "extension-module" || entry.state !== "active") continue;
		const extension = await loadExtensionOnce(entry.path, cwd);
		if (!extension) continue;
		for (const component of extension.components ?? []) {
			const absPath = path.resolve(extension.resolvedPath, "..", component.moduleUrl);
			try {
				const compiled = await compileComponentModule(absPath);
				out.push({
					slot: component.slot,
					extensionId: extension.path,
					label: component.label,
					code: compiled.code,
					...(compiled.css ? { css: compiled.css } : {}),
					...(component.order !== undefined ? { order: component.order } : {}),
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
 * (registerRpc). Loaded through the shared
 * 10s load-once cache; unknown methods throw so the daemon surfaces a
 * JSON-RPC error to the GUI caller.
 */
export async function invokeExtensionRpc(
	entryPath: string,
	cwd: string,
	method: string,
	params: unknown,
	ctx: { cwd: string; sessionId?: string },
): Promise<unknown> {
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
		if (entry.kind !== "extension-module" || entry.state !== "active") continue;
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
export async function collectToolViews(
	extensions: ReadonlyArray<{ kind: string; state: string; path: string }>,
	cwd: string,
): Promise<ToolViewItem[]> {
	const out: ToolViewItem[] = [];
	for (const entry of extensions) {
		if (entry.kind !== "extension-module" || entry.state !== "active") continue;
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
