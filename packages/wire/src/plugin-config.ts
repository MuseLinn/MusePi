/**
 * 插件/扩展声明式配置契约(设计稿 `docs/review/0.5.0-m2-cordis-builtin-capabilities-design.md`
 * §1/§4):manifest `config` 字段的字段描述,驱动扩展中心管理页的 schema 驱动
 * 配置表单。daemon 与 GUI 共用本契约,schema 方言是「TS interface + 常量表」,
 * 不引入 schemastery(dsh 的价值在渲染器契约,与 schema 方言解耦)。
 *
 * 校验哲学(回退保护①):manifest 是用户可写的 JSON——逐字段 fail-soft,
 * 坏字段丢弃并给结构化原因,绝不让一个坏字段拖垮整个扩展的登记。
 */

/** 单个配置字段的声明式描述(渲染器的输入)。 */
export interface ConfigFieldDesc {
	key: string;
	type: "boolean" | "number" | "string" | "select" | "path";
	/** 缺省值;缺席 = 必填。 */
	default?: unknown;
	min?: number;
	max?: number;
	step?: number;
	/** select 用。 */
	options?: readonly string[];
	/** 进管理页表单行 desc(i18n 键或原文)。 */
	description?: string;
	/** 变更生效域:none = 立即;session = 重启会话;daemon = 重启 daemon。 */
	restart?: "none" | "session" | "daemon";
}

/** 资源需求卡(manifest `resources`,dsh 五段式第 3 段)。全部为可选展示项。 */
export interface PluginResources {
	disk?: string;
	memory?: string;
	setupMinutes?: number;
	models?: { name: string; size?: string; downloadUrl?: string }[];
}

export type ConfigFieldErrorCode =
	| "config-not-an-object"
	| "field-not-an-object"
	| "field-bad-key"
	| "field-bad-type"
	| "field-bad-default"
	| "field-bad-select";

export interface ConfigFieldError {
	code: ConfigFieldErrorCode;
	field?: string;
	detail?: string;
}

export interface ParsedConfigFields {
	fields: ConfigFieldDesc[];
	errors: ConfigFieldError[];
}

const FIELD_TYPES = new Set(["boolean", "number", "string", "select", "path"]);
const RESTARTS = new Set(["none", "session", "daemon"]);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验 manifest `config` 字段(未校验的 unknown)。坏字段丢弃进 errors,好
 * 字段原样通过——管理页可逐字段呈现「该字段声明无效」而不丢整个扩展。
 * 非数组/非对象 → 空 fields + 一条结构化错误。
 */
export function parseConfigFields(raw: unknown): ParsedConfigFields {
	if (raw === undefined || raw === null) return { fields: [], errors: [] };
	const list = Array.isArray(raw) ? raw : isRecord(raw) ? Object.values(raw) : null;
	if (list === null) {
		return { fields: [], errors: [{ code: "config-not-an-object", detail: typeof raw }] };
	}
	const fields: ConfigFieldDesc[] = [];
	const errors: ConfigFieldError[] = [];
	for (const item of list) {
		if (!isRecord(item)) {
			errors.push({ code: "field-not-an-object", detail: String(item)?.slice(0, 80) });
			continue;
		}
		const key = item.key;
		if (typeof key !== "string" || key.trim() === "") {
			errors.push({ code: "field-bad-key" });
			continue;
		}
		const type = item.type;
		if (typeof type !== "string" || !FIELD_TYPES.has(type)) {
			errors.push({ code: "field-bad-type", field: key, detail: String(type) });
			continue;
		}
		const desc: ConfigFieldDesc = { key, type: type as ConfigFieldDesc["type"] };
		if (item.default !== undefined) {
			const t = typeof item.default;
			const ok =
				(type === "boolean" && t === "boolean") ||
				(type === "number" && t === "number") ||
				((type === "string" || type === "path") && t === "string") ||
				(type === "select" && (t === "string" || t === "number"));
			if (!ok) {
				errors.push({ code: "field-bad-default", field: key, detail: t });
				continue;
			}
			desc.default = item.default;
		}
		if (typeof item.min === "number") desc.min = item.min;
		if (typeof item.max === "number") desc.max = item.max;
		if (typeof item.step === "number") desc.step = item.step;
		if (typeof item.description === "string") desc.description = item.description;
		if (typeof item.restart === "string" && RESTARTS.has(item.restart)) {
			desc.restart = item.restart as ConfigFieldDesc["restart"];
		}
		if (type === "select") {
			const opts = Array.isArray(item.options) ? item.options.filter(o => typeof o === "string") : [];
			if (opts.length === 0) {
				errors.push({ code: "field-bad-select", field: key });
				continue;
			}
			desc.options = opts;
		}
		fields.push(desc);
	}
	return { fields, errors };
}

/** 资源需求卡校验(更宽松:逐字段取可用者,全坏 = undefined)。 */
export function parsePluginResources(raw: unknown): PluginResources | undefined {
	if (!isRecord(raw)) return undefined;
	const out: PluginResources = {};
	if (typeof raw.disk === "string") out.disk = raw.disk;
	if (typeof raw.memory === "string") out.memory = raw.memory;
	if (typeof raw.setupMinutes === "number" && Number.isFinite(raw.setupMinutes)) out.setupMinutes = raw.setupMinutes;
	if (Array.isArray(raw.models)) {
		const models = raw.models
			.filter(isRecord)
			.map(m => ({
				name: typeof m.name === "string" ? m.name : "",
				...(typeof m.size === "string" ? { size: m.size } : {}),
				...(typeof m.downloadUrl === "string" ? { downloadUrl: m.downloadUrl } : {}),
			}))
			.filter(m => m.name !== "");
		if (models.length > 0) out.models = models;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
