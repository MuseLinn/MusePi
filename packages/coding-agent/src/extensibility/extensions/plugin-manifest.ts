/**
 * 扩展插件清单(plugin manifest)的 config/resources 读取与校验。
 *
 * dsh 插件管理页五段式契约的第一段:扩展的 package.json 在 `omp`/`pi`
 * 字段下可声明 `config`(配置字段表)与 `resources`(资源占用声明),
 * 扩展中心详情页据此渲染 dsh 式配置表单与资源卡。
 *
 * 校验哲学(fail-soft,回退保护①):manifest 是用户可写 JSON,逐字段
 * 校验——坏字段进结构化 errors 被丢弃,好字段照常通过,不让一个坏
 * 字段拖垮整个扩展的登记。解析器本体在 `@musepi/pi-wire`(daemon 与
 * GUI 共用契约,见 docs/review/0.5.0-m2-cordis-builtin-capabilities-design.md §4)。
 *
 * 生命周期:每次扩展扫描(loadAllExtensions)对每个 extension-module
 * 调用一次;extensions.list 有 TTL 缓存,代价有界。
 */
import * as path from "node:path";
import { isEacces, isEnoent } from "@musepi/pi-utils";
import type { ConfigFieldDesc, ConfigFieldError, PluginResources } from "@musepi/pi-wire";
import { parseConfigFields, parsePluginResources } from "@musepi/pi-wire";

/** 从入口文件向上查找 package.json 的最大目录层级。 */
const MAX_MANIFEST_DEPTH = 4;

/**
 * 一个扩展插件声明的、已通过校验的配置与资源元数据。
 */
export interface ExtensionPluginMeta {
	/** 通过校验的配置字段表(空数组 = 未声明任何字段)。 */
	fields: ConfigFieldDesc[];
	/** 被丢弃的坏字段及其原因(展示用,fail-soft 证据)。 */
	configErrors: ConfigFieldError[];
	/** 声明的资源占用(disk/memory/setup/models)。 */
	resources?: PluginResources;
}

/**
 * 从扩展入口文件解析插件清单。向上逐层查找最近的带 `omp`/`pi` 字段的
 * package.json;找不到或 JSON 不可读返回 null(不是插件声明,无元数据)。
 */
export async function readExtensionPluginMeta(entryPath: string): Promise<ExtensionPluginMeta | null> {
	const raw = await readManifestBlock(entryPath);
	if (!raw) return null;
	const { fields, errors } = parseConfigFields(raw.config);
	const resources = parsePluginResources(raw.resources);
	if (fields.length === 0 && errors.length === 0 && !resources) {
		return null;
	}
	return { fields, configErrors: errors, resources };
}

async function readManifestBlock(entryPath: string): Promise<{ config?: unknown; resources?: unknown } | null> {
	let dir = path.dirname(entryPath);
	for (let depth = 0; depth < MAX_MANIFEST_DEPTH; depth++) {
		const packageJsonPath = path.join(dir, "package.json");
		try {
			const pkg = (await Bun.file(packageJsonPath).json()) as {
				omp?: { config?: unknown; resources?: unknown };
				pi?: { config?: unknown; resources?: unknown };
			};
			const block = pkg.omp ?? pkg.pi;
			if (block && typeof block === "object") {
				return block;
			}
		} catch (error) {
			if (!isEnoent(error) && !isEacces(error)) {
				// 损坏的 JSON 按"无插件声明"处理,不阻断扩展登记。
				return null;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}
