import { logger } from "@musepi/pi-utils";
import type { PresetPluginRow, ResolvedMode } from "../../presets/resolve";
import type { EventBus } from "../../utils/event-bus";
import type { Extension } from "../extensions/types";
import { CordisPresetRuntime } from "./preset-runtime";
import type { MountContext } from "./runtime/mount";

/** One live preset composition: its resolved definition and registration records. */
export interface PresetMountRecord {
	readonly id: string;
	readonly definition: ResolvedMode;
	extensions: Extension[];
	runtime?: CordisPresetRuntime;
	broken?: string;
}

/** Resolve package names to their extension entry paths for a preset mount. */
export interface PresetEntryResolver {
	resolveEntries(): Promise<Map<string, string[]>>;
}

export interface PresetServiceOptions {
	eventBus: EventBus;
	runtime: MountContext["runtime"];
	readConfig: MountContext["readConfig"];
	entryResolver: PresetEntryResolver;
	cwd: string;
}

/** Preset declarations mounted as real Cordis fibers, with errors isolated per preset. */
export class PresetRegistry {
	readonly #definitions = new Map<string, PresetMountRecord>();
	readonly #options: PresetServiceOptions;

	constructor(options: PresetServiceOptions) {
		this.#options = options;
	}

	list(): PresetMountRecord[] {
		return [...this.#definitions.values()];
	}

	get(id: string): PresetMountRecord | undefined {
		return this.#definitions.get(id);
	}

	async register(definition: ResolvedMode, enabledRows: readonly PresetPluginRow[]): Promise<void> {
		if (definition.id.trim() === "") throw new Error("Preset id must not be empty");
		if (this.#definitions.has(definition.id)) throw new Error(`Duplicate preset: ${definition.id}`);
		const record: PresetMountRecord = { id: definition.id, definition, extensions: [] };
		this.#definitions.set(definition.id, record);
		try {
			const runtime = new CordisPresetRuntime({
				cwd: this.#options.cwd,
				eventBus: this.#options.eventBus,
				runtime: this.#options.runtime,
				entryResolver: this.#options.entryResolver,
				readConfig: this.#options.readConfig,
			});
			record.runtime = runtime;
			const result = await runtime.mount(enabledRows);
			record.extensions = result.records.map(mounted => mounted.extension);
			if (result.errors.length > 0) {
				record.broken = result.errors.map(error => `${error.path}: ${error.error}`).join("; ");
				logger.warn(`preset ${definition.id} 的插件装载失败`, { errors: result.errors });
			}
		} catch (error) {
			record.broken = error instanceof Error ? error.message : String(error);
			logger.warn(`preset ${definition.id} 挂载失败: ${record.broken}`);
		}
	}

	async unregister(id: string): Promise<void> {
		const record = this.#definitions.get(id);
		this.#definitions.delete(id);
		await record?.runtime?.dispose();
	}

	async dispose(): Promise<void> {
		for (const id of [...this.#definitions.keys()]) await this.unregister(id);
	}
}
