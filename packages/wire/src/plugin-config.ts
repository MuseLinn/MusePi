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
	/** 字段显示名(i18n 键或原文;GUI 经 t() 解析,缺省回退 key)。 */
	label?: string;
	/** select 选项的显示名(value → i18n 键或原文;GUI 经 t() 解析)。 */
	optionLabels?: Record<string, string>;
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

/**
 * 插件清单声明的「包含的组件」(manifest `components`,dsh bundle 插件
 * `cordis.patch.yml` 的 `- insert:` 子插件 parity):每个组件是**独立装载
 * 单元**——清单给出 `entry`(相对清单目录的模块路径)时,宿主装载把它挂为
 * 插件 fiber 下的独立子 fiber(独立效果账本/启停/reload);无 `entry` 的
 * 组件是纯展示声明(只读行,不渲染开关,不发明启停语义)。
 */
export interface PluginComponentDecl {
	id: string;
	description?: string;
	/** 组件入口模块路径(相对清单所在目录);缺席 = 只读展示组件。 */
	entry?: string;
}

/**
 * 插件「包含的组件」描述(dsh 插件详情页「包含的组件 · 每组件独立开关」
 * 段;daemon 下发状态,GUI 渲染开关行)。组件 = 该插件单元暴露给 agent 的
 * 真实工具(tools/index.ts 的 isToolAllowed 谓词消费同一份 tools.disabled
 * 黑名单),canToggle=false 的组件只读展示(尚无独立启停语义,不发明)。
 */
export interface PluginComponentDesc {
	/** 组件 id:对工具组件即 wire 工具名(setComponentEnabled 的 component 参数)。 */
	id: string;
	/** 显示名(GUI i18n 键或原文)。 */
	name: string;
	description?: string;
	/** 当前是否可用(不在 tools.disabled 黑名单内)。 */
	enabled: boolean;
	/** false = 只读展示,不渲染开关。 */
	canToggle: boolean;
	/** 不可用原因(被黑名单禁用时给出)。 */
	disabledReason?: string;
	/** entry 组件的真实 cordis 运行面(fiber 状态机 + 效果账本计数);
	 *  宿主无 fiber 的组件(软开关/未装载)无此项——如实,不编造。 */
	runtime?: { fiberState: string; effects: number };
}

export type ConfigFieldErrorCode =
	| "config-not-an-object"
	| "field-not-an-object"
	| "field-bad-key"
	| "field-bad-type"
	| "field-bad-default"
	| "field-bad-select";

/**
 * 插件兼容性预检结果（回退保护②，dsh plugin-compatibility.ts parity）：
 * 在不 import 插件代码的前提下读 package.json `peerDependencies`，对
 * MusePi 命名空间 peer（`@musepi/*`，平台单版本线——全部对照宿主运行时
 * 版本判定）做 semver 区间校验。compatible = 本类型实例不存在（undefined）；
 * 命中未满足 peer 才产出实例。exempted = 人工登记的精确版本豁免命中
 * （放行但如实标注）。调用方按 code 本地化渲染，不散装 Error.message。
 */
export interface PluginCompatibility {
	/** 不兼容 / 豁免后的最终判定（compatible 不产出实例）。 */
	status: "incompatible" | "exempted";
	/** 结构化拒绝码，调用方本地化渲染。 */
	code: "incompatible-version" | "incompatible-peer" | "malformed-manifest";
	plugin: { name: string; version: string };
	/** 宿主运行时版本（判定基准）。 */
	runtimeVersion: string;
	/** 未满足的 peer 区间（仅 @musepi/* peer 参与判定）。 */
	unmetPeers: Record<string, string>;
	/** malformed-manifest 时的校验细节（展示用,可本地化）。 */
	detail?: string;
}

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
		if (typeof item.label === "string") desc.label = item.label;
		if (isRecord(item.optionLabels)) {
			const labels: Record<string, string> = {};
			for (const [value, text] of Object.entries(item.optionLabels)) {
				if (typeof text === "string" && text.trim() !== "") labels[value] = text;
			}
			if (Object.keys(labels).length > 0) desc.optionLabels = labels;
		}
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

/** 组件声明表校验(manifest `components`,fail-soft 同 parseConfigFields):
 *  逐条取可用者(id 非空字符串必填;entry/description 取字符串),坏条目进
 *  errors 被丢弃,不让一个坏组件拖垮整个插件的登记。 */
export function parsePluginComponents(raw: unknown): { components: PluginComponentDecl[]; errors: ConfigFieldError[] } {
	const components: PluginComponentDecl[] = [];
	const errors: ConfigFieldError[] = [];
	if (raw === undefined || raw === null) return { components, errors };
	if (!Array.isArray(raw)) {
		errors.push({ code: "config-not-an-object", detail: typeof raw });
		return { components, errors };
	}
	for (const item of raw) {
		if (!isRecord(item)) {
			errors.push({ code: "field-not-an-object", detail: String(item)?.slice(0, 80) });
			continue;
		}
		const id = item.id;
		if (typeof id !== "string" || id.trim() === "") {
			errors.push({ code: "field-bad-key" });
			continue;
		}
		const decl: PluginComponentDecl = { id };
		if (typeof item.description === "string") decl.description = item.description;
		if (typeof item.entry === "string" && item.entry.trim() !== "") decl.entry = item.entry;
		components.push(decl);
	}
	return { components, errors };
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

/** 插件配置的值表(storage 形态:key → 值)。 */
export type PluginConfigValues = Record<string, unknown>;

/**
 * 单字段取值钳制(写入与读取共用契约):任何与声明不符的原始值都回退到
 * 字段默认值(fail-soft,不抛错);数字额外夹取 [min, max] 声明区间。
 * daemon 的 setConfig 写入校验与 GUI 的表单渲染都必须走这一个函数,
 * 保证两端对"什么是合法值"的定义永不漂移。
 */
export function coerceConfigFieldValue(desc: ConfigFieldDesc, raw: unknown): unknown {
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

/** 全表钳制:以清单为准过滤未知键、修正坏值,得到完整值集。 */
export function coerceConfigValues(
	fields: ConfigFieldDesc[],
	stored: PluginConfigValues | undefined,
): PluginConfigValues {
	const out: PluginConfigValues = {};
	for (const desc of fields) {
		out[desc.key] = coerceConfigFieldValue(desc, stored?.[desc.key]);
	}
	return out;
}
