/**
 * 能力缝声明（索引：docs/capability-seams.md「Cordis preset 组合运行时」）：
 * - 名称+ns：`CordisPresetRuntime`，preset 行的 Cordis Context/fiber 装配。
 * - 输入：preset 行、包入口解析器、会话 cwd/event bus、注册运行时和配置读取器。
 * - 输出：真实 fiber 与注册记录、按行归因而非静默丢弃的装载错误。
 * - 生命周期：会话创建时挂载，preset 切换或会话销毁时反向 dispose；effect 随 fiber 回收。
 * - 启停：禁用的行不挂载；`isolate` 通过 `Context.isolate()` 创建服务 realm。
 * - 冲突：persona 由原生 prompt 投影处理；同路径的 preset 注册取代普通会话注册，不重复导入。
 * - 检视入口：本文件、`preset-registry.ts`、profile preset 解析与 SDK 会话测试。
 */
import { Context, type Fiber } from "@deepseek-ai/cordis";
import type { PresetPluginRow } from "../../presets/resolve";
import type { EventBus } from "../../utils/event-bus";
import type { Extension } from "../extensions/types";
import type { PresetEntryResolver } from "./preset-registry";
import { HOST_SERVICES, providedServices, type ServiceRegistry } from "./runtime/cordis-entry";
import { disposePluginPrimitives } from "./runtime/cordis-primitives";
import { type MountContext, mountPlugin } from "./runtime/mount";

export interface MountedPresetPlugin {
	fiber: Fiber;
	extension: Extension;
	row: PresetPluginRow;
}

export interface PresetMountResult {
	records: MountedPresetPlugin[];
	errors: Array<{ path: string; error: string }>;
}

export interface CordisPresetRuntimeOptions {
	cwd: string;
	eventBus: EventBus;
	runtime: MountContext["runtime"];
	entryResolver: PresetEntryResolver;
	readConfig: MountContext["readConfig"];
}

function isolated(scope: Context, declaration: PresetPluginRow["isolate"]): Context {
	let next = scope;
	for (const [name, enabled] of Object.entries(declaration ?? {})) {
		if (enabled) next = next.isolate(name);
	}
	return next;
}

function services(scope: Context): ServiceRegistry {
	return {
		host: HOST_SERVICES,
		hasProvided: name => scope.get(name, false) !== undefined,
		providerOf: () => undefined,
		resolve: <T>(name: string): T | undefined => scope.get(name, false) as T | undefined,
	};
}

/** Session-owned Cordis composition; fibers, not registration records, own plugin lifetime. */
export class CordisPresetRuntime {
	readonly #options: CordisPresetRuntimeOptions;
	readonly #root = new Context();
	/** Identity of this preset generation; instance listeners carry it. */
	readonly key = {};
	readonly #mounted = new Set<MountedPresetPlugin>();

	constructor(options: CordisPresetRuntimeOptions) {
		this.#options = options;
	}

	async mount(rows: readonly PresetPluginRow[]): Promise<PresetMountResult> {
		const result: PresetMountResult = { records: [], errors: [] };
		const entries = await this.#options.entryResolver.resolveEntries();
		await this.#mountRows(rows, this.#root, entries, result);
		return result;
	}

	async #mountRows(
		rows: readonly PresetPluginRow[],
		scope: Context,
		entries: ReadonlyMap<string, string[]>,
		result: PresetMountResult,
	): Promise<void> {
		for (const row of rows) {
			if (row.enabled === false || (row.id === "persona" && row.name === "@musepi/persona")) continue;
			const rowScope = isolated(scope, row.isolate);
			if (row.group === true) {
				await this.#mountRows(Array.isArray(row.config) ? row.config : [], rowScope, entries, result);
				continue;
			}
			for (const entryPath of entries.get(row.name) ?? []) {
				await this.#mountEntry(row, entryPath, rowScope, result);
			}
			if (!entries.has(row.name)) result.errors.push({ path: row.name, error: "plugin package is not installed" });
		}
	}

	async #mountEntry(
		row: PresetPluginRow,
		entryPath: string,
		scope: Context,
		result: PresetMountResult,
	): Promise<void> {
		let mountedRecord: MountedPresetPlugin | undefined;
		try {
			const fiber = scope.plugin({
				name: row.id ?? row.name,
				apply: async ctx => {
					const ownConfig = row.group !== true && !Array.isArray(row.config) ? row.config : undefined;
					const mounted = await mountPlugin({
						entryPath,
						cwd: this.#options.cwd,
						eventBus: this.#options.eventBus,
						runtime: this.#options.runtime,
						serviceRegistry: services(scope),
						additionalInject: row.inject,
						scopeTag: this.key,
						readConfig: async path => {
							const base = await this.#options.readConfig(path);
							return { ...base, values: { ...base.values, ...(ownConfig ?? {}) } };
						},
					});
					if (!mounted.ok) throw new Error(`${mounted.code}: ${mounted.message}`);
					for (const name of providedServices(mounted.entry)) ctx.provide(name, mounted.published?.[name]);
					ctx.effect(() => async () => {
						await disposePluginPrimitives(mounted.extension);
					});
					mountedRecord = { fiber, extension: mounted.extension, row };
				},
			});
			await fiber.await();
			if (mountedRecord) {
				this.#mounted.add(mountedRecord);
				result.records.push(mountedRecord);
			}
		} catch (error) {
			result.errors.push({ path: entryPath, error: error instanceof Error ? error.message : String(error) });
		}
	}

	async dispose(): Promise<void> {
		const records = [...this.#mounted].reverse();
		this.#mounted.clear();
		for (const record of records) await record.fiber.dispose();
	}
}
