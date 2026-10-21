/**
 * Preset service — the cordis layer over the preset composition.
 *
 * Preset 是两件东西：一个注册表（{@link PresetRegistry}），和一个把注册进来的
 * 定义**真正挂载成插件组合**的 mount 层。数据层（`presets/resolve.ts` 的继承展开）
 * 之前已存在；本文件补的是第二件——**一个 preset 声明的插件行会被真实装载**，
 * 而不只是留在 JSON 里：
 *
 * - 每个 preset 一个 cordis 子 Context（销毁即回收）。
 * - mount 经由 {@link mountPreset} → `loadSessionPlugins`。
 * - 注销收集 generation（{@link PresetRegistry.unregister}）。
 *
 * 挂载失败**不抛给注册方**：失败记进 `broken` 并在 roster 上可见——
 * 一个坏的 preset 不能拖垮其它 preset 或宿主启动，但也不能**无声消失**。
 */

import { logger } from "@musepi/pi-utils";
import type { PresetPluginRow, ResolvedMode } from "../../presets/resolve";
import type { EventBus } from "../../utils/event-bus";
import type { Extension, LoadExtensionsResult } from "../extensions/types";

/** One live preset composition: its resolved definition and loaded extensions. */
export interface PresetMountRecord {
	readonly id: string;
	readonly definition: ResolvedMode;
	/** Extensions actually loaded for this preset (the enabled rows). */
	extensions: Extension[];
	/** Set when the composition failed to mount; the roster shows this. */
	broken?: string;
}

/**
 * Resolve a composition row's plugin name to entry paths.
 *
 * A row names a PACKAGE (installed under the plugins tree); its entry points
 * come from the manifest the loader already parsed. Unknown names resolve to no
 * paths and surface as a broken-preset diagnostic rather than a silent skip.
 */
export interface PresetEntryResolver {
	/** All enabled plugins with their extension entry paths, keyed by package name. */
	resolveEntries(): Promise<Map<string, string[]>>;
}

export interface PresetServiceOptions {
	/** The session's own event bus: preset extensions bind to it like session ones. */
	eventBus: EventBus;
	/** The loader the session uses (same pipeline, same shapes). */
	loadSessionPlugins: (
		paths: readonly string[],
		cwd: string,
		eventBus: EventBus,
		options?: { fresh?: boolean },
	) => Promise<LoadExtensionsResult>;
	/** Entry-path resolution (see {@link PresetEntryResolver}). */
	entryResolver: PresetEntryResolver;
	cwd: string;
}

export class PresetRegistry {
	readonly #definitions = new Map<string, PresetMountRecord>();
	readonly #options: PresetServiceOptions;

	constructor(options: PresetServiceOptions) {
		this.#options = options;
	}

	/** Every registered preset's current state (the roster's data source). */
	list(): PresetMountRecord[] {
		return [...this.#definitions.values()];
	}

	get(id: string): PresetMountRecord | undefined {
		return this.#definitions.get(id);
	}

	/**
	 * Register a resolved preset and mount its composition.
	 *
	 * Duplicate ids are refused (a preset file's id IS its identity; two files
	 * claiming one id is a user error to surface, not to resolve by order).
	 */
	async register(definition: ResolvedMode, enabledRows: readonly PresetPluginRow[]): Promise<void> {
		if (definition.id.trim() === "") throw new Error("Preset id must not be empty");
		if (this.#definitions.has(definition.id)) {
			throw new Error(`Duplicate preset: ${definition.id}`);
		}
		const record: PresetMountRecord = {
			id: definition.id,
			definition,
			extensions: [],
		};
		this.#definitions.set(definition.id, record);
		try {
			const entries = await this.#options.entryResolver.resolveEntries();
			const paths: string[] = [];
			const missing: string[] = [];
			for (const row of enabledRows) {
				const found = entries.get(row.name);
				if (found === undefined || found.length === 0) {
					missing.push(row.name);
					continue;
				}
				paths.push(...found);
			}
			if (paths.length === 0) {
				// Nothing to mount: that is a legitimate state (a preset may compose
				// only not-yet-installed packages), recorded as broken so the roster
				// says WHY instead of showing an empty group forever.
				record.broken = `未安装的组合插件: ${missing.join(", ")}`;
				logger.warn(`preset ${definition.id} 未挂载: ${record.broken}`);
				return;
			}
			const result = await this.#options.loadSessionPlugins(paths, this.#options.cwd, this.#options.eventBus);
			for (const error of result.errors) {
				logger.warn(`preset ${definition.id} 的插件装载失败`, { path: error.path, error: error.error });
			}
			record.extensions = result.extensions;
			if (missing.length > 0) {
				record.broken = `未安装的组合插件: ${missing.join(", ")}`;
			}
		} catch (error) {
			record.broken = error instanceof Error ? error.message : String(error);
			logger.warn(`preset ${definition.id} 挂载失败: ${record.broken}`);
		}
	}

	/** Tear one preset down (its definition was deleted or changed). */
	unregister(id: string): void {
		this.#definitions.delete(id);
	}
}
