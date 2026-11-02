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
import * as path from "node:path";
import { isEacces, isEnoent } from "@musepi/pi-utils";
import type { ConfigFieldDesc, ConfigFieldError, PluginComponentDecl, PluginResources } from "@musepi/pi-wire";
import { parseConfigFields, parsePluginComponents, parsePluginResources } from "@musepi/pi-wire";

/** 从入口文件向上查找 package.json 的最大目录层级。 */
const MAX_MANIFEST_DEPTH = 4;

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
	/** 声明的「包含的组件」(dsh 子插件 parity;entry 组件 = 独立装载单元)。 */
	components?: PluginComponentDecl[];
	label?: string;
	description?: string;
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
	const raw = await readManifestBlock(entryPath);
	if (!raw) return null;
	const { fields, errors } = parseConfigFields(raw.config);
	const resources = parsePluginResources(raw.resources);
	const { components } = parsePluginComponents(raw.components);
	const host = parseHostBinding(raw.host);
	const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
	const description =
		typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : undefined;
	if (
		fields.length === 0 &&
		errors.length === 0 &&
		!resources &&
		components.length === 0 &&
		!host &&
		!label &&
		!description
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
		...(host ? { host } : {}),
	};
}

interface ManifestBlock {
	config?: unknown;
	resources?: unknown;
	components?: unknown;
	label?: unknown;
	description?: unknown;
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

async function readManifestBlock(entryPath: string): Promise<ManifestBlock | null> {
	const manifest = await readPackageManifestNear(entryPath);
	if (!manifest) return null;
	return manifest.pkg.musepi ?? manifest.pkg.omp ?? manifest.pkg.pi ?? null;
}
