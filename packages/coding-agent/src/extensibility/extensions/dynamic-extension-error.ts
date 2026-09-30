/**
 * 宿主级动态装载的结构化错误（收编第二刀）：
 * code 供管理面归因（collision / entry-missing / manifest-invalid /
 * factory-threw），message 为教学式文案。独立成叶子模块——loader 的
 * bind 路径捕获 factory 抛错时须能识别本类错误并把 code 透传出去
 * （否则碰撞归因被「Failed to load extension:」字符串包装淹没）。
 */

export type DynamicExtensionLoadErrorCode =
	| "entry-missing"
	| "manifest-invalid"
	| "collision"
	| "factory-threw"
	| "incompatible-version"
	| "incompatible-peer"
	| "malformed-manifest";

export class DynamicExtensionLoadError extends Error {
	constructor(
		readonly code: DynamicExtensionLoadErrorCode,
		message: string,
	) {
		super(message);
		this.name = "DynamicExtensionLoadError";
	}
}
