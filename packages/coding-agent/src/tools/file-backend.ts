/**
 * 文件子系统后端组件通道（插件化第五刀：musepi:file 包）。
 *
 * dsh fs 插件族 parity（fs / tool-fs / tool-str-replace-editor /
 * tool-fs-search）：file 内置单元从「散置的工具 + 索引」收编为一个插件
 * 包，四个真实后端组件独立启停：
 *
 * - `read`   —— read 工具族（文件 / pdf / sqlite / archive 选择器读取）
 * - `write`  —— write 工具族（write / edit / ast_edit）
 * - `search` —— glob / grep / ast_grep 检索工具族
 * - `index`  —— 工作区文件内容索引（file-index 后台扫描）
 *
 * 组件开关（extensions.setComponentEnabled 经 extension-service）写隐藏键
 * `file.disabledBackends`（settings-schema 登记、fail-soft 读取）。消费
 * 哲学与 terminal/browser 组件一致：禁用是显式意图——read/write/search
 * 被禁后工具不再进入会话工具集（不静默留桩），index 被禁后 daemon 停止
 * 后台扫描（既有 FTS 数据仍由 index.setEnabled 总开关治理，不越权）。
 *
 * 映射单一事实源 = 本模块的 FILE_TOOL_BACKENDS；builtin-registry file 行
 * 的 components 声明与契约测试对两边做交集断言。
 */

/** 文件后端组件 id（builtin-registry file 行 components 声明同步）。 */
export const FILE_BACKEND_COMPONENTS = ["read", "write", "search", "index"] as const;
export type FileBackendComponent = (typeof FILE_BACKEND_COMPONENTS)[number];

/** 工具名 → 后端组件分组的唯一映射；null = 非文件子系统工具。 */
const FILE_TOOL_BACKENDS: Record<string, FileBackendComponent> = {
	read: "read",
	write: "write",
	edit: "write",
	ast_edit: "write",
	glob: "search",
	grep: "search",
	ast_grep: "search",
};

export function fileBackendForTool(name: string): FileBackendComponent | null {
	return FILE_TOOL_BACKENDS[name] ?? null;
}

/** 读文件后端组件黑名单（fail-soft：坏值/非数组 = 空集）。组件开关
 *  （extensions.setComponentEnabled 经 extension-service）写
 *  `file.disabledBackends`，本模块的谓词与 daemon 索引扫描门是消费方。 */
export function readDisabledFileBackends(source: { get(key: string): unknown }): Set<string> {
	let raw: unknown;
	try {
		raw = source.get("file.disabledBackends");
	} catch {
		return new Set();
	}
	if (!Array.isArray(raw)) return new Set();
	return new Set(raw.filter((item): item is string => typeof item === "string"));
}

/** 工具允许谓词（tools/index.ts isToolAllowed 消费）：工具名不属文件
 *  子系统恒允许；所属后端被禁则不允许——被禁工具不再进入 slate，与
 *  tools.disabled 同帧同语义（禁用是显式意图，不静默留桩）。 */
export function isFileBackendToolAllowed(name: string, source: { get(key: string): unknown }): boolean {
	const backend = fileBackendForTool(name);
	if (backend === null) return true;
	return !readDisabledFileBackends(source).has(backend);
}

/** 索引扫描门（daemon server.ts index.scan 消费）：`index` 组件被禁时
 *  停止后台扫描。返回 false = 扫描被组件开关禁用（区别于
 *  index.setEnabled 的索引总开关——后者治理已有数据的查询面）。 */
export function isFileIndexBackendEnabled(source: { get(key: string): unknown }): boolean {
	return !readDisabledFileBackends(source).has("index");
}
