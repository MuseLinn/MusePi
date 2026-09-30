/**
 * 插件配置存储:扩展中心管理页表单的写入落点。
 *
 * 形态:`<agentDir>/extensions/plugin-config.json` = `{ [extensionId]:
 * { [key]: value } }`。键空间与 disabledExtensions 一致(`kind:name`),
 * 值是已经过 `coerceConfigFieldValue` 钳制的合法值——钳制在 RPC 处理
 * 里做,本模块只负责忠实地读写字节(fail-soft:文件损坏按空存储处理,
 * 绝不抛错阻断扩展登记)。
 *
 * 生命周期:daemon 内进程级缓存 + 单次写穿透;测试与多实例场景可注入
 * storePath 覆盖默认路径。
 */
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@musepi/pi-utils";
import type { PluginConfigValues } from "@musepi/pi-wire";

export type PluginConfigStore = Record<string, PluginConfigValues>;

/** 默认存储路径(<agentDir>/extensions/plugin-config.json)。 */
export function getPluginConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "plugin-config.json");
}

let cache: { path: string; store: PluginConfigStore } | null = null;

function isValues(v: unknown): v is PluginConfigValues {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 读取整个存储;损坏/缺席返回空表。可用 storePath 覆盖(测试注入)。 */
export async function readPluginConfigStore(storePath: string = getPluginConfigPath()): Promise<PluginConfigStore> {
	if (cache && cache.path === storePath) return cache.store;
	let parsed: unknown;
	try {
		parsed = await Bun.file(storePath).json();
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("plugin config store unreadable, starting empty", { path: storePath, error: String(error) });
		}
		cache = { path: storePath, store: {} };
		return {};
	}
	const store: PluginConfigStore = {};
	if (isValues(parsed)) {
		for (const [extId, values] of Object.entries(parsed)) {
			if (isValues(values)) store[extId] = values;
		}
	}
	cache = { path: storePath, store };
	return store;
}

/** 写入单键并穿透落盘;返回写入后的该扩展值表。 */
export async function writePluginConfigValue(
	extId: string,
	key: string,
	value: unknown,
	storePath: string = getPluginConfigPath(),
): Promise<PluginConfigValues> {
	const store = await readPluginConfigStore(storePath);
	const next: PluginConfigStore = { ...store, [extId]: { ...store[extId], [key]: value } };
	await Bun.write(storePath, JSON.stringify(next, null, "\t"));
	cache = { path: storePath, store: next };
	return next[extId]!;
}

/** 测试/多实例辅助:清掉进程级缓存,强制下次重读。 */
export function resetPluginConfigStoreCache(): void {
	cache = null;
}
