import type { ConfigFieldDesc } from "@musepi/pi-wire";

/**
 * 插件配置值助手(ConfigFormRenderer 与未来的写入链路共用)。
 *
 * 契约:配置值来自用户可写存储(JSON),字段类型以清单声明为准——
 * 任何与声明不符的原始值都必须回退到字段默认值(fail-soft,不抛错、
 * 不写坏值)。数字字段额外夹取到 [min, max] 声明区间。
 */
export type PluginConfigValues = Record<string, unknown>;

/** 单字段的取值回退 + 类型钳制。raw 无效时返回 desc.default。 */
export function coerceConfigValue(desc: ConfigFieldDesc, raw: unknown): unknown {
	switch (desc.type) {
		case "boolean":
			return typeof raw === "boolean" ? raw : desc.default;
		case "number": {
			const n = typeof raw === "number" ? raw : Number(raw);
			if (Number.isNaN(n)) return desc.default;
			let clamped = n;
			if (typeof desc.min === "number") clamped = Math.max(desc.min, clamped);
			if (typeof desc.max === "number") clamped = Math.min(desc.max, clamped);
			return clamped;
		}
		case "select":
			return typeof raw === "string" && (desc.options ?? []).includes(raw) ? raw : desc.default;
		case "string":
		case "path":
			return typeof raw === "string" ? raw : desc.default;
	}
}

/** 全表回退:以清单为准过滤未知键、修正坏值,得到可渲染的完整值集。 */
export function defaultsConfigValues(
	fields: ConfigFieldDesc[],
	stored: PluginConfigValues | undefined,
): PluginConfigValues {
	const out: PluginConfigValues = {};
	for (const desc of fields) {
		out[desc.key] = coerceConfigValue(desc, stored?.[desc.key]);
	}
	return out;
}
