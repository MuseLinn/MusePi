import * as path from "node:path";
import { getAgentDir, getConfigDirName, getPluginsDir } from "@musepi/pi-utils";
import { resolveActiveProjectRegistryPath } from "../discovery/helpers";

/**
 * 扩展 / 插件热重载的监视根。
 *
 * 这些根**必须与发现/加载实际读取的根一致** —— 否则 watcher 盯的是没人加载的
 * 目录,而唯一的症状是"我改了插件但什么都没发生"。四个来源:
 *
 *   - `<agentDir>/extensions`:用户级扩展模块;
 *   - `<cwd>/<configDir>/extensions`:项目级扩展模块;
 *   - `getPluginsDir()`:市场安装 / `plugin link` 的插件住在这里。**此前不在
 *     列表里** —— 于是用户唯一能安装的那批插件恰好是唯一完全没有热重载的那批,
 *     而开发者手写的扩展(默认落在 agent/extensions)一切正常,这个缺口因此
 *     很难被本地开发发现;
 *   - 项目插件根 `<anchor>/<configDir>/plugins`:anchor 由
 *     `resolveActiveProjectRegistryPath` 向上查找(先 `<configDir>/` 再 `.git`,
 *     不到家目录为止),与安装/卸载/列表/discovery/doctor 共用同一判定 —— 这里
 *     必须复用它而不是自己再写一遍向上查找,否则两边会漂:旧代码硬编码
 *     `cwd/.musepi/extensions`,既不含 anchor 之上的项目插件根,也不含
 *     `getPluginsDir()`。
 *
 * 项目根需要逐级 `stat`,所以本函数是 async;调用方在 daemon 启动时 await 一次。
 *
 * `home` 参数只为测试隔离存在(`getPluginsDir` 的同名短路):不传时走生产解析。
 */
export async function resolveExtensionWatchRoots(cwd: string, home?: string): Promise<string[]> {
	const roots = [
		path.join(getAgentDir(), "extensions"),
		path.join(cwd, getConfigDirName(), "extensions"),
		getPluginsDir(home),
	];
	const registry = await resolveActiveProjectRegistryPath(cwd);
	if (registry) roots.push(path.dirname(registry));
	return [...new Set(roots)];
}
