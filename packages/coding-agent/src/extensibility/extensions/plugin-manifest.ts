/**
 * 扩展插件清单(plugin manifest)的 config/resources 读取与校验。
 *
 * dsh 插件管理页五段式契约的第一段:扩展的 package.json 在 `musepi` 字段
 * 下可声明 `config`(配置字段表)、`resources`(资源占用声明)与
 * `components`(「包含的组件」子插件声明),
 * 扩展中心详情页据此渲染 dsh 式配置表单与资源卡。`omp`/`pi` 是旧上游
 * 兼容的遗留字段(继续可读,新扩展一律写 `musepi`)。
 *
 * 校验哲学(fail-soft,回退保护①):manifest 是用户可写 JSON,逐字段
 * 校验——坏字段进结构化 errors 被丢弃,好字段照常通过,不让一个坏
 * 字段拖垮整个扩展的登记。解析器本体在 `@musepi/pi-wire`(daemon 与
 * GUI 共用契约,见 docs/review/0.5.0-m2-cordis-builtin-capabilities-design.md §4)。
 *
 * 生命周期:每次扩展扫描(loadAllExtensions)对每个 extension-module
 * 调用一次;extensions.list 有 TTL 缓存,代价有界。
 */
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { isEacces, isEnoent, logger } from "@musepi/pi-utils";
import type {
	ConfigFieldDesc,
	ConfigFieldError,
	LocalizedPluginText,
	PluginComponentDecl,
	PluginResources,
} from "@musepi/pi-wire";
import {
	localizedPluginText,
	parseConfigFields,
	parsePluginComponents,
	parsePluginExperimental,
	parsePluginResources,
} from "@musepi/pi-wire";

/** 从入口文件向上查找 package.json 的最大目录层级。 */
const MAX_MANIFEST_DEPTH = 4;

/** `locale/<tag>.json` 的文件名即语言标签（与 `locale/en.json` 同构）。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

/**
 * 一个扩展插件声明的、已通过校验的配置与资源元数据。
 */
/** Host presentation and configuration owned by a plugin package. Cordis owns
 * package and component identity, enablement, and lifecycle for every plugin. */
export interface ExtensionHostBinding {
	configStorage?: "settings";
	readonly?: boolean;
	raw?: unknown;
}

export interface ExtensionPluginMeta {
	/** 通过校验的配置字段表(空数组 = 未声明任何字段)。 */
	fields: ConfigFieldDesc[];
	/** 被丢弃的坏字段及其原因(展示用,fail-soft 证据)。 */
	configErrors: ConfigFieldError[];
	/** 声明的资源占用(disk/memory/setup/models)。 */
	resources?: PluginResources;
	/** 声明的「包含的组件」(子插件契约;entry 组件 = 独立装载单元)。 */
	components?: PluginComponentDecl[];
	label?: string;
	description?: string;
	/**
	 * 按语言分列的显示名/说明(`locale/*.json` 声明时才有)。
	 *
	 * 只在包里真的带了 locale 文件时出现:没有文件的插件由 `label` /
	 * `description` 承担,不再下发一份只有 `en` 的冗余映射。语言由界面挑,
	 * daemon 不下判断(同一个 daemon 可以同时服务中文 TUI 与英文 GUI)。
	 */
	labelText?: LocalizedPluginText;
	descriptionText?: LocalizedPluginText;
	/** 清单声明的图标：emoji、文字字形或 http(s)/file URI（插件列表与详情共用）。 */
	icon?: string;
	/** 只在 Agent 预设里按会话提供的 persona 包：没有独立的用户启停面。 */
	presetOnly?: boolean;
	experimental?: boolean;
	host?: ExtensionHostBinding;
}

function parseHostBinding(raw: unknown): ExtensionHostBinding | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	const binding: ExtensionHostBinding = {
		...(value.configStorage === "settings" ? { configStorage: "settings" } : {}),
		...(value.readonly === true ? { readonly: true } : {}),
		...("raw" in value ? { raw: value.raw } : {}),
	};
	return binding.configStorage || binding.readonly || "raw" in binding ? binding : undefined;
}

/**
 * 从扩展入口文件解析插件清单。向上逐层查找最近的带 `musepi`（或遗留
 * `omp`/`pi`）字段的 package.json；找不到或 JSON 不可读返回 null(不是
 * 插件声明,无元数据)。
 */
export async function readExtensionPluginMeta(entryPath: string): Promise<ExtensionPluginMeta | null> {
	const manifest = await readPackageManifestNear(entryPath);
	const raw = manifest?.pkg.musepi ?? manifest?.pkg.omp ?? manifest?.pkg.pi ?? null;
	if (!raw || !manifest) return null;
	const { fields, errors } = parseConfigFields(raw.config);
	const resources = parsePluginResources(raw.resources);
	const { components } = parsePluginComponents(raw.components);
	const experimental = parsePluginExperimental(raw.experimental);
	const host = parseHostBinding(raw.host);
	const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
	const description =
		typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined;
	const icon = typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : undefined;
	const presetOnly = raw.presetOnly === true;
	// 语言文案只在包里带了 locale 文件时读目录；没有就是空表,不产生多余字段。
	const locale = manifest.root ? await readLocaleText(manifest.root) : { titles: {}, descriptions: {} };
	const labelText = Object.keys(locale.titles).length > 0 ? localizedPluginText(label, locale.titles) : undefined;
	const descriptionText =
		Object.keys(locale.descriptions).length > 0 ? localizedPluginText(description, locale.descriptions) : undefined;
	if (
		fields.length === 0 &&
		errors.length === 0 &&
		!resources &&
		components.length === 0 &&
		!host &&
		!label &&
		!description &&
		!icon &&
		!presetOnly &&
		!experimental
	) {
		return null;
	}
	return {
		fields,
		configErrors: errors,
		...(resources ? { resources } : {}),
		...(components.length > 0 ? { components } : {}),
		...(label ? { label } : {}),
		...(description ? { description } : {}),
		...(labelText ? { labelText } : {}),
		...(descriptionText ? { descriptionText } : {}),
		...(icon ? { icon } : {}),
		...(presetOnly ? { presetOnly } : {}),
		...(experimental ? { experimental } : {}),
		...(host ? { host } : {}),
	};
}

interface ManifestBlock {
	config?: unknown;
	resources?: unknown;
	components?: unknown;
	label?: unknown;
	description?: unknown;
	icon?: unknown;
	presetOnly?: unknown;
	experimental?: unknown;
	host?: unknown;
}

interface PackageManifest {
	name?: unknown;
	musepi?: ManifestBlock;
	omp?: ManifestBlock;
	pi?: ManifestBlock;
}

export interface ExtensionPluginPackage {
	name: string;
	root: string;
}

/** Resolve the package identity that owns an entrypoint and its bundled resources. */
export async function readExtensionPluginPackage(entryPath: string): Promise<ExtensionPluginPackage | null> {
	const manifest = await readPackageManifestNear(entryPath);
	return manifest && typeof manifest.pkg.name === "string" && manifest.pkg.name.length > 0
		? { name: manifest.pkg.name, root: manifest.root }
		: null;
}

async function readPackageManifestNear(entryPath: string): Promise<{ pkg: PackageManifest; root: string } | null> {
	let dir = path.dirname(entryPath);
	for (let depth = 0; depth < MAX_MANIFEST_DEPTH; depth++) {
		const packageJsonPath = path.join(dir, "package.json");
		try {
			const pkg = (await Bun.file(packageJsonPath).json()) as PackageManifest;
			// musepi 为权威字段；omp/pi 是旧上游兼容遗留（继续可读）。
			const block = pkg.musepi ?? pkg.omp ?? pkg.pi;
			if (block && typeof block === "object") return { pkg, root: dir };
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

/** 一个包的 `locale/*.json` 里声明的显示文案,按语言标签分列。 */
interface LocaleText {
	titles: Record<string, string>;
	descriptions: Record<string, string>;
}

/**
 * 读 `<root>/locale/<tag>.json`(dsh `locale/en.json` 同构)。
 *
 * 每个文件是 `{ "meta": { "title", "description" } }`;文件名即语言标签,
 * 由界面按自己的语言挑。**没有 `locale/` 目录是常态**(大多数插件只有清单
 * 里那一句兜底文案),ENOENT 直接返回空。坏文件按 manifest 的 fail-soft
 * 纪律处理:跳过并记一条 warn,不拖垮整个扩展的登记。
 */
/**
 * 清单声明的名字（`musepi.label`），给宿主做「扩展叫什么」的默认值。
 *
 * 与 {@link readExtensionPluginMeta} 分开是因为调用点不同：装载一个扩展时只需要
 * 一个名字，不需要读 `locale/` 目录、也不需要校验 config 字段表。
 */
export async function readExtensionPluginLabel(entryPath: string): Promise<string | undefined> {
	const manifest = await readPackageManifestNear(entryPath);
	const raw = manifest?.pkg.musepi ?? manifest?.pkg.omp ?? manifest?.pkg.pi ?? null;
	if (!raw || typeof raw !== "object") return undefined;
	const label = (raw as { label?: unknown }).label;
	return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

async function readLocaleText(root: string): Promise<LocaleText> {
	const out: LocaleText = { titles: {}, descriptions: {} };
	const dir = path.join(root, "locale");
	let names: string[];
	try {
		const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
		names = entries.filter(entry => entry.isFile()).map(entry => entry.name);
	} catch (error) {
		if (!(isEnoent(error) || isEacces(error))) {
			logger.warn(`plugin locale directory unreadable: ${dir}`, { error: String(error) });
		}
		return out;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const language = name.slice(0, -".json".length);
		if (!LANGUAGE_ID.test(language)) {
			logger.warn(`plugin locale file ignored (not a language tag): ${path.join(dir, name)}`);
			continue;
		}
		const file = path.join(dir, name);
		try {
			const parsed = (await Bun.file(file).json()) as { meta?: unknown } | null;
			const meta = parsed?.meta;
			if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
			const title = textField((meta as Record<string, unknown>).title);
			const description = textField((meta as Record<string, unknown>).description);
			if (title) out.titles[language] = title;
			if (description) out.descriptions[language] = description;
		} catch (error) {
			logger.warn(`plugin locale file unreadable: ${file}`, { error: String(error) });
		}
	}
	return out;
}

/** 一个可选的本地化文本字段:非空字符串才算声明。 */
function textField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
