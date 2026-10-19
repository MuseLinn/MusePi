/**
 * M2-2.9 收编第二刀：user 插件宿主级 cordis 装载运行时（生产接线）。
 *
 * 能力缝声明（M2-2.4）：
 * - 名称+ns：`cordis-dynamic-plugins`（daemon 装配面，宿主级）
 * - 输入：扩展入口路径清单（discoverExtensionPaths 同源发现分支输出）+
 *   宿主 cwd + DaemonHostContext 根 Context
 * - 输出：LoadExtensionsResult（extensions/errors/runtime——与 loadExtensions
 *   同形状，供 session-less RPC 消费）+ DynamicPluginHandle（invoke/
 *   检视/unload/reload）+ 结构化加载错误 + DynamicPluginInspection[]
 * - 生命周期：每个 user 插件 = `musepi-dynamic-extensions` 组 fiber 下的
 *   独立子 fiber；每次 register 类动词/on 登记 = fiber 效果账本（ctx.effect）
 *   一条带标签 effect，卸载即 fiber.dispose() 反向回收。清单
 *   `musepi.components` 声明的 entry 组件 = 插件 fiber 下的
 *   组件子 fiber（独立启停/检视/热重载）。
 *
 * - 启停：随 daemon 进程；runtime.dispose() 幂等拆卸整组
 * - 冲突：与 extensions/loader（会话级装配权威）分层——本文件管宿主级
 *   session-less 装载（getExtensionRuntimeLoad），会话内装载仍走
 *   ExtensionRunner（设计稿 §9 第二刀边界：宿主级先切 fiber，会话级后切）
 *
 * 与"模型生成代码 + 沙箱"那套形态的差异（如实记录）：
 * - 那套做法里，插件 = 模型生成的 host/client 双半体**代码字符串**，经 node:vm
 *   沙箱产出 cordis Plugin，apply 拿到的是真 ctx 的白名单 façade（guard.ts）。
 * - 我们动态装载的是**真实 user 扩展目录**（package.json + TS 入口），
 *   运行面是既有 pi.* ExtensionAPI——它本身就是 façade：user 代码永不接触
 *   cordis ctx，无需再包一层 vm。但这只收窄 API 面，**不是进程隔离**：
 * - 扩展与 daemon 同进程全权限运行（环境变量、文件系统、网络都可达）。
 *   零信任前提我们不具备——代码是用户自己装的，不是模型现场生成的。
 * - API 面与生产会话装载**同源**（loader.ts 的 createConcreteExtensionAPI
 *   唯一工厂 + importAndBindExtension 同一条 import/bind 管线），本文件只
 *   加两样东西：ctx.effect 效果账本壳（ledgerApi，每登记 verb 一条带
 *   标签 effect + dispose 反向撤销）与跨扩展命令名碰撞守卫。
 * - cordis 在此纯做三件事：生命周期（fiber state 机 + dispose 效果回收）、
 *   登记守卫的落地载体（碰撞 = apply 抛错 = FAILED fiber，不留半挂载）、
 *   检视（fiber.state + getEffects() 效果账本诊断树）。
 *
 * HMR 实测口径（Windows + Bun 1.4.2 实测，spike 报告 §1 结论，定案不重新讨论）：
 *   · 裸 `import("file:///…?t=N")` 查询串**不能**击穿同进程模块缓存；
 *   · Bun.plugin onLoad 同样只按解析路径缓存，自定义命名空间方案不可用；
 *   · 可靠口径 = loader 的 loadLegacyPiModule **每次装载自带单调 `?mtime=` 查询
 *     标签**（raw path 而非 file://，legacy-pi-compat.ts 注释明确该机制，
 *     P5 扩展 HMR 生产依赖它）——入口与子模块改写都在 reload 重新装载时
 *     拾取，无需暂存复制。宿主级 runtime 经失效入口 reconcile：新路径装载、
 *     消失路径卸载（效果账本反向回收）。
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Context, Fiber, Plugin } from "@deepseek-ai/cordis";
import type { KeyId } from "@musepi/pi-tui";
import { logger } from "@musepi/pi-utils";
import { type PluginCompatibility, type PluginComponentDecl, parsePluginComponents } from "@musepi/pi-wire";
import { getExtensionNameFromPath } from "../discovery/helpers";
import { DynamicExtensionLoadError } from "../extensibility/extensions/dynamic-extension-error";
import type {
	Extension,
	ExtensionAPI,
	ExtensionCommandContext,
	LoadExtensionsResult,
} from "../extensibility/extensions/types";
import { readCompatibilityExemptions, resolveCompatibilityPath } from "../extensibility/plugins/compatibility-store";
import {
	type CordisPluginEntry,
	HOST_SERVICES,
	providedServices,
	type ServiceRegistry,
} from "../extensibility/plugins/cordis-entry";
import {
	compatibilityGateForExtensionPath,
	pluginCompatibilityWarning,
} from "../extensibility/plugins/plugin-compatibility";
import { PluginFileIdentities } from "../extensibility/plugins/plugin-file-identities";
import { EventBus } from "../utils/event-bus";
import type { DaemonHostContext } from "./host-context";

export { DynamicExtensionLoadError } from "../extensibility/extensions/dynamic-extension-error";

/** fiber.state 数值镜像（cordis FiberState 是 const enum，跨模块不可 import；
 *  镜像必须与 vendor/cordis 的枚举序一致：PENDING..UNLOADING = 0..5）。 */
const FIBER_STATE_FAILED = 3;
const FIBER_STATE_NAMES = ["PENDING", "LOADING", "ACTIVE", "FAILED", "DISPOSED", "UNLOADING"] as const;

/** 文件输入向上查找清单 package.json 的最大目录层级
 *  （与 plugin-manifest.ts 的 MAX_MANIFEST_DEPTH 同口径）。 */
const MAX_MANIFEST_DEPTH = 4;

/** 装载目标：入口解析结果（文件输入走发现管线；目录输入走清单声明）。 */
interface ExtensionTarget {
	/** 扩展身份名（getExtensionNameFromPath——与 discoverExtensionPaths 的
	 *  disabled 过滤 `extension-module:<name>` 同一命名法，reconcile 的键）。 */
	name: string;
	/** 解析后的入口文件绝对路径（reconcile 判同键）。 */
	entry: string;
	/** 清单声明的组件表（目录输入读 package.json；文件输入为空）。 */
	components: PluginComponentDecl[];
	/** 清单所在目录（组件 entry 相对路径的解析基准；文件输入缺席）。 */
	manifestDir?: string;
	/** 清单版本（豁免键 `name@version` 与 list 面版本标注的输入）。 */
	version?: string;
}

/** 插件内组件的装载记录（entry 组件 = 插件 fiber 下的独立子 fiber）。 */
interface DynamicComponentRecord {
	id: string;
	description?: string;
	status: "active" | "disabled" | "failed" | "unloaded";
	fiber?: Fiber;
	/** 组件入口绑定的扩展面（句柄 invoke 的组件命令查找面）。 */
	extension?: Extension;
	error?: string;
}

export interface DynamicComponentInspection {
	id: string;
	status: DynamicComponentRecord["status"];
	fiberState?: string;
	effectLabels: string[];
	error?: string;
}

export interface DynamicPluginInspection {
	name: string;
	status: "active" | "unloaded" | "failed";
	/** 清单版本（兼容面豁免键/版本标注的输入）。 */
	version?: string;
	/** cordis fiber 生命周期状态名（FAILED 已拆卸的 fiber 无此项）。 */
	fiberState?: string;
	/** fiber 效果账本标签（检视 = getEffects() 诊断树，空数组表示已拆卸）。 */
	effectLabels: string[];
	error?: string;
	/** 兼容性预检判定（回退保护②）：incompatible = 结构化拒绝的证据面,
	 *  exempted = 放行但如实标注。兼容（无未满足 peer）无此项。 */
	compatibility?: PluginCompatibility;
	/** 清单声明的组件装载面（无组件声明 = 空数组）。 */
	components: DynamicComponentInspection[];
}

export interface DynamicPluginHandle {
	readonly name: string;
	/** 调用该扩展登记的命令（不存在 = 结构化「能力缺席」错误——禁用兜底的渲染输入）。
	 *  handler 签名为 (args, ctx)——宿主级无会话 ctx，默认存根在访问任何
	 *  字段时抛「需要会话」；忽略 ctx 的命令可直接调用。 */
	invoke(commandName: string, args?: string): Promise<unknown>;
	unload(): Promise<void>;
	/** 拆卸后按目录重新装载（入口文件改写即拾取新代码）。 */
	reload(): Promise<void>;
}

interface DynamicPluginRecord {
	name: string;
	/** 原始输入路径（reload 重解析入口用）。 */
	sourcePath: string;
	/** 解析后的入口绝对路径（reconcile 判同键）。 */
	entryKey: string;
	cwd: string;
	status: "active" | "unloaded" | "failed";
	fiber?: Fiber;
	/** 插件 fiber 的 Context（组件子 fiber 的挂载点;插件存活期内有效）。 */
	ctx?: Context;
	extension?: Extension;
	error?: string;
	/** 清单版本（兼容性豁免键 `name@version` 的输入）。 */
	version?: string;
	/** 兼容性预检判定（回退保护②）：拒绝时 = 结构化证据,随记录与
	 *  inspect() 下发;exempted = 放行但标注。兼容 = 无此项。 */
	compatibility?: PluginCompatibility;
	/** 插件入口用 cordis 三件套声明且携带 Config 时，已钳制的配置值。
	 *  供 inspect() 暴露"这个插件实际拿到了什么配置"；未声明 = 无此项。 */
	declaredConfig?: Record<string, unknown>;
	/** 清单声明组件的装载记录（键 = 组件 id）。 */
	components: Map<string, DynamicComponentRecord>;
}

/** 扩展目录 package.json 中声明的清单字段形状。
 *  musepi 为权威字段；omp/pi 是旧上游兼容遗留。 */
interface ExtensionManifestPkg {
	name?: string;
	version?: string;
	musepi?: { extensions?: string[]; components?: unknown };
	omp?: { extensions?: string[]; components?: unknown };
	pi?: { extensions?: string[]; components?: unknown };
}

/** 目录输入：读 package.json 清单，解析声明入口（musepi 权威，omp/pi 兼容；
 *  声明文件 → 自身；目录 → index.{ts,js,mjs,cjs}）与组件声明表、版本。 */
async function resolveManifestTarget(
	dir: string,
): Promise<{ entry: string; components: PluginComponentDecl[]; version?: string }> {
	const pkgPath = path.join(dir, "package.json");
	let raw: string;
	try {
		raw = await fs.readFile(pkgPath, "utf8");
	} catch (err) {
		throw new DynamicExtensionLoadError("manifest-invalid", `extension at "${dir}" has no readable package.json`);
	}
	let pkg: ExtensionManifestPkg;
	try {
		pkg = JSON.parse(raw) as ExtensionManifestPkg;
	} catch {
		throw new DynamicExtensionLoadError("manifest-invalid", `extension at "${dir}" has invalid package.json JSON`);
	}
	const { components } = parsePluginComponents(pkg.musepi?.components ?? pkg.omp?.components ?? pkg.pi?.components);
	const declared = pkg.musepi?.extensions ?? pkg.omp?.extensions ?? pkg.pi?.extensions ?? [];
	const first = declared[0];
	const joined = first ? path.resolve(dir, first) : dir;
	const version = typeof pkg.version === "string" ? pkg.version : undefined;
	let stats: Stats;
	try {
		stats = await fs.stat(joined);
	} catch {
		throw new DynamicExtensionLoadError("entry-missing", `extension entry "${joined}" does not exist`);
	}
	if (!stats.isDirectory()) return { entry: joined, components, version };
	for (const ext of [".ts", ".js", ".mjs", ".cjs"]) {
		try {
			await fs.stat(path.join(joined, `index${ext}`));
			return { entry: path.join(joined, `index${ext}`), components, version };
		} catch {
			/* try next */
		}
	}
	throw new DynamicExtensionLoadError("entry-missing", `extension directory "${joined}" has no index file`);
}

/** 把发现管线给出的路径（入口文件或目录）解析为装载目标。
 *  文件输入：入口即自身；目录输入：清单声明入口（与 plugins/loader 同一
 *  发现约定）。身份名取 getExtensionNameFromPath——与 discoverExtensionPaths
 *  的 disabled 过滤 `extension-module:<name>` 同一命名法，reconcile 以入口
 *  绝对路径判同键。
 *  组件声明两种入口都收：目录输入直接读清单；文件输入向上找带清单声明的
 *  package.json（与 readExtensionPluginMeta 同深度口径）,且仅当其声明入口
 *  解析到本文件时才采用——裸文件扩展不会误吸项目根的清单。 */
async function resolveExtensionTarget(inputPath: string): Promise<ExtensionTarget> {
	const resolved = path.resolve(inputPath);
	let stats: Stats;
	try {
		stats = await fs.stat(resolved);
	} catch {
		throw new DynamicExtensionLoadError("entry-missing", `extension path "${resolved}" does not exist`);
	}
	if (stats.isDirectory()) {
		const manifest = await resolveManifestTarget(resolved);
		return {
			name: getExtensionNameFromPath(manifest.entry),
			entry: manifest.entry,
			components: manifest.components,
			manifestDir: resolved,
			version: manifest.version,
		};
	}
	const sibling = await resolveSiblingManifest(resolved);
	return {
		name: getExtensionNameFromPath(resolved),
		entry: resolved,
		components: sibling?.components ?? [],
		...(sibling ? { manifestDir: sibling.manifestDir, version: sibling.version } : {}),
	};
}

/** 文件输入的清单组件解析：向上逐层找带 musepi/omp/pi 块且声明了入口的
 *  package.json,声明入口解析到本文件 → 采用其组件声明与版本;命中声明别的入口
 *  → 本文件不属于该插件,返回 null;无声明入口的纯配置块继续向上。 */
async function resolveSiblingManifest(
	filePath: string,
): Promise<{ components: PluginComponentDecl[]; manifestDir: string; version?: string } | null> {
	let dir = path.dirname(filePath);
	for (let depth = 0; depth < MAX_MANIFEST_DEPTH; depth++) {
		let block: { extensions?: string[]; components?: unknown } | undefined;
		let version: string | undefined;
		try {
			const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8")) as ExtensionManifestPkg;
			block = pkg.musepi ?? pkg.omp ?? pkg.pi;
			version = typeof pkg.version === "string" ? pkg.version : undefined;
		} catch {
			block = undefined;
		}
		if (block && typeof block === "object") {
			const first = block.extensions?.[0];
			if (typeof first !== "string") continue;
			const joined = path.resolve(dir, first);
			let entryFile: string | null = null;
			const joinedStats = await fs.stat(joined).catch(() => null);
			if (joinedStats && !joinedStats.isDirectory()) {
				entryFile = joined;
			} else if (joinedStats) {
				for (const ext of [".ts", ".js", ".mjs", ".cjs"]) {
					try {
						await fs.stat(path.join(joined, `index${ext}`));
						entryFile = path.join(joined, `index${ext}`);
						break;
					} catch {
						/* try next */
					}
				}
			}
			if (entryFile !== filePath) return null;
			return { components: parsePluginComponents(block.components).components, manifestDir: dir, version };
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/** 宿主级命令 ctx 存根：宿主装载无会话，handler 访问任何 ctx 字段即抛
 *  教学式错误（忽略 ctx 的命令不受影响）。 */
const HOST_COMMAND_CTX = new Proxy(
	{},
	{
		get: (_target, prop) => {
			throw new Error(`host-level extension command ctx.${String(prop)} requires a session`);
		},
	},
) as unknown as ExtensionCommandContext;

/** 效果账本覆盖的登记动词（每 verb = 一种「登记 = fiber effect」贡献面）。 */
const LEDGERED_VERBS = new Set([
	"on",
	"registerCommand",
	"registerTool",
	"registerFileWriteFallback",
	"registerFileDeleteFallback",
	"registerSetting",
	"registerComponent",
	"registerRpc",
	"registerSkill",
	"registerToolView",
	"registerPrompt",
	"registerMode",
	"registerShortcut",
	"registerFlag",
	"registerMessageRenderer",
	"registerAssistantThinkingRenderer",
	"registerComposerShape",
	"registerNotificationChannel",
	"registerService",
	"registerThemeToken",
	"registerStatusBarSegment",
	"registerProvider",
	"registerMediaProvider",
	"registerDesignSystem",
]);

/** 从登记参数提取效果标签键（取不到就退回 verb 本身——标签是诊断面，不追求唯一）。 */
function effectLabel(verb: string, args: unknown[]): string {
	const first = args[0];
	if (typeof first === "string" && first.length > 0) return `${verb}:${first}`;
	if (first && typeof first === "object") {
		const rec = first as Record<string, unknown>;
		for (const key of ["name", "key", "id", "slot"]) {
			const value = rec[key];
			if (typeof value === "string" && value.length > 0) return `${verb}:${value}`;
		}
		const style = rec.style as Record<string, unknown> | undefined;
		if (style && typeof style.id === "string" && style.id.length > 0) return `${verb}:${style.id}`;
	}
	return verb;
}

function removeIdentity(list: unknown[], item: unknown): void {
	const index = list.indexOf(item);
	if (index >= 0) list.splice(index, 1);
}

/** 每 verb 的撤销逻辑：dispose 时把登记从 extension 集合/共享 runtime 摘除
 *  （卸载即反向回收效果账本）。 */
function undoRegistration(verb: string, api: ExtensionAPI, extension: Extension, args: unknown[]): () => void {
	switch (verb) {
		case "on": {
			const [event, handler] = args as [string, unknown];
			return () => {
				const list = extension.handlers.get(event);
				if (!list) return;
				removeIdentity(list as unknown[], handler);
				if (list.length === 0) extension.handlers.delete(event);
			};
		}
		case "registerCommand": {
			const [name] = args as [string];
			return () => {
				extension.commands.delete(name);
			};
		}
		case "registerTool": {
			const [tool] = args as [{ name: string }];
			return () => {
				extension.tools.delete(tool.name);
			};
		}
		case "registerFileWriteFallback": {
			const [handler] = args as [unknown];
			return () => {
				removeIdentity(extension.fileWriteFallbackHandlers as unknown[], handler);
			};
		}
		case "registerFileDeleteFallback": {
			const [handler] = args as [unknown];
			return () => {
				removeIdentity(extension.fileDeleteFallbackHandlers as unknown[], handler);
			};
		}
		case "registerSetting": {
			const [setting] = args as [{ key: string }];
			return () => {
				extension.settings.delete(setting.key);
			};
		}
		case "registerComponent": {
			const [component] = args as [unknown];
			return () => {
				removeIdentity(extension.components as unknown[], component);
			};
		}
		case "registerRpc": {
			const [method] = args as [string];
			return () => {
				extension.rpcs.delete(method);
			};
		}
		case "registerSkill": {
			const [skill] = args as [unknown];
			return () => {
				removeIdentity(extension.skills as unknown[], skill);
			};
		}
		case "registerToolView": {
			const [tool] = args as [string];
			return () => {
				const index = extension.toolViews.findIndex(view => view.tool === tool);
				if (index >= 0) extension.toolViews.splice(index, 1);
			};
		}
		case "registerPrompt": {
			const [section] = args as [unknown];
			return () => {
				removeIdentity(extension.promptSections as unknown[], section);
			};
		}
		case "registerMode": {
			const [mode] = args as [{ id: string }];
			return () => {
				const index = extension.modes.findIndex(entry => entry.id === mode.id);
				if (index >= 0) extension.modes.splice(index, 1);
			};
		}
		case "registerShortcut": {
			const [shortcut] = args as [KeyId];
			return () => {
				extension.shortcuts.delete(shortcut);
			};
		}
		case "registerFlag": {
			const [name] = args as [string];
			// flagValues 默认值留在共享 runtime（布尔/字符串默认值，无害；
			// 共享 runtime 无删除 API，会话级装载不受影响）。
			return () => {
				extension.flags.delete(name);
			};
		}
		case "registerMessageRenderer": {
			const [customType] = args as [string];
			return () => {
				extension.messageRenderers.delete(customType);
			};
		}
		case "registerAssistantThinkingRenderer": {
			const [renderer] = args as [unknown];
			return () => {
				removeIdentity(extension.assistantThinkingRenderers as unknown[], renderer);
			};
		}
		case "registerComposerShape": {
			const [definition] = args as [{ style: { id: string } }];
			return () => {
				extension.composerShapes.delete(definition.style.id);
			};
		}
		case "registerNotificationChannel": {
			const [channel] = args as [string];
			return () => {
				const index = extension.notificationChannels.findIndex(entry => entry.channel === channel);
				if (index >= 0) extension.notificationChannels.splice(index, 1);
			};
		}
		case "registerService": {
			const [name] = args as [string];
			return () => {
				const index = extension.services.findIndex(entry => entry.name === name);
				if (index >= 0) extension.services.splice(index, 1);
			};
		}
		case "registerThemeToken": {
			const [key] = args as [string];
			return () => {
				const index = extension.themeTokens.findIndex(entry => entry.key === key);
				if (index >= 0) extension.themeTokens.splice(index, 1);
			};
		}
		case "registerStatusBarSegment": {
			const [id] = args as [string];
			return () => {
				const index = extension.statusBarSegments.findIndex(entry => entry.id === id);
				if (index >= 0) extension.statusBarSegments.splice(index, 1);
			};
		}
		case "registerProvider": {
			const [name] = args as [string];
			return () => {
				api.unregisterProvider(name);
			};
		}
		case "registerMediaProvider": {
			const [config] = args as [{ id: string }];
			return () => {
				api.unregisterMediaProvider(config.id);
			};
		}
		case "registerDesignSystem": {
			const [config] = args as [{ id: string }];
			return () => {
				api.unregisterDesignSystem(config.id);
			};
		}
		default:
			return () => {};
	}
}

export class CordisDynamicPluginRuntime {
	readonly #host: DaemonHostContext;
	#group?: Fiber & PromiseLike<Fiber>;
	readonly #records = new Map<string, DynamicPluginRecord>();
	/** 全局登记命名空间：command:name → owner 扩展（跨扩展碰撞守卫）。 */
	readonly #registrations = new Map<string, string>();
	/** 宿主级共享装配面：与 loadExtensions 每调用新建不同，fiber 运行时跨
	 *  reconcile 持久——登记随 fiber 生命周期走，TTL 重入不重复登记。 */
	#runtime: LoadExtensionsResult["runtime"] | null = null;
	/** 插件间服务面：service name → provider plugin name。只收**在役**插件的
	 *  `provide`，卸载即摘除——一个名字只有在提供者活着时才可被 inject。 */
	/** 插件间服务面：service name → 提供者与它发布的对象。只收**在役**插件的
	 *  `provide`，卸载即整条摘除——一个名字只有在提供者活着时才可被 inject。 */
	readonly #providedServices = new Map<string, { owner: string; service?: unknown }>();
	readonly #eventBus = new EventBus();
	/** 在役插件入口的磁盘身份——reconcile 靠它判断哪个插件的文件变了
	 *  （HMR）。判定口径（inode+size+mtime、2 秒容差、标记文件取时钟）
	 *  见 PluginFileIdentities 的模块注释。 */
	readonly #files = new PluginFileIdentities();

	constructor(host: DaemonHostContext) {
		this.#host = host;
	}

	/**
	 * The `inject` resolution surface for mounts in progress.
	 *
	 * Reads {@link #providedServices}, so a plugin mounted AFTER its provider
	 * sees it and one mounted BEFORE does not (and is refused with the
	 * provider's name in the message, so the ordering problem is diagnosable
	 * instead of looking like a typo).
	 */
	#serviceRegistry(): ServiceRegistry {
		const provided = this.#providedServices;
		return {
			host: HOST_SERVICES,
			hasProvided: (name: string) => provided.has(name),
			providerOf: (name: string) => provided.get(name)?.owner,
			// The object the PROVIDER published. Reading it here (rather than
			// keeping a second map) means there is exactly one place a service
			// object lives, so a provider cannot publish a name and forget the
			// object, or vice versa.
			resolve: <T>(name: string): T | undefined => provided.get(name)?.service as T | undefined,
		};
	}

	/** 记录一个在役插件提供的服务名与对象（装载成功后调用；卸载由
	 *  #forgetProvidedServices 反向摘除——名字和对象一起消失）。
	 *
	 *  `published` 是 `apply` 的返回值：一个以 `provide` 名为键的对象。每个名字
	 *  取自己那一个字段，所以 `pi.service("a")` 得到的是 `published.a` 而不是整个
	 *  返回值——否则一个只 provide 一个名字的插件也会让消费者拿到多余的东西。 */
	#rememberProvidedServices(name: string, entry: CordisPluginEntry | null, published?: Record<string, unknown>): void {
		for (const service of providedServices(entry)) {
			this.#providedServices.set(service, { owner: name, service: published?.[service] });
		}
	}

	/** 卸载时摘除该插件提供的全部服务名（连同它发布的对象）。 */
	#forgetProvidedServices(name: string): void {
		for (const [service, entry] of [...this.#providedServices]) {
			if (entry.owner === name) this.#providedServices.delete(service);
		}
	}

	/** 动态插件组 fiber：首个 load 时创建，
	 *  所有动态扩展的子 fiber 挂在它下面，拆卸整组 = dispose 它一个。 */
	async #ensureGroup(): Promise<Fiber> {
		if (!this.#group) {
			const fiber = this.#host.plugin({ name: "musepi-dynamic-plugins", apply: () => {} });
			this.#group = fiber;
			// startHostHalf parity：先等组落定再挂子 fiber。
			await fiber.await();
		}
		return this.#group;
	}

	async #sharedRuntime(): Promise<LoadExtensionsResult["runtime"]> {
		if (!this.#runtime) {
			const { ExtensionRuntime } = await import("../extensibility/extensions/loader");
			this.#runtime = new ExtensionRuntime();
		}
		return this.#runtime;
	}

	/** 兼容性预检（回退保护②，先于任何 import）：读清单 package.json 的
	 *  MusePi peer 区间,对照运行时版本判定。incompatible = 结构化拒绝
	 *  （调用方记 failed + 抛结构化码）;exempted = 放行但标注。
	 *  豁免清单读 agentDir/compatibility.json,fail-safe（坏文件 = 零豁免
	 *  + 日志警告,永不阻塞装配）。peer 元数据不可验证（malformed）按
	 *  口径是拒绝而非静默准入。判定本体 = plugin-compatibility 的
	 *  纯函数（三个装配入口共用同一判定）。 */
	async #compatibilityPreflight(target: ExtensionTarget): Promise<PluginCompatibility | undefined> {
		if (!target.manifestDir) return undefined;
		const { exemptions, warnings } = readCompatibilityExemptions(resolveCompatibilityPath());
		for (const warning of warnings) logger.warn(warning);
		return compatibilityGateForExtensionPath(target.manifestDir, exemptions);
	}

	/** 装载一个真实 user 扩展（目录或入口文件）。失败不留半挂载 fiber
	 *  （startHostHalf parity：FAILED fiber 立即 dispose）。同名扩展非 active
	 *  状态（failed/unloaded）时复用记录重载。
	 *  disabledComponents：清单组件的禁用集合（`<plugin>/<component>` 复合键，
	 *  由调用方从 settings 读入）——命中的 entry 组件不挂 fiber,如实记 disabled。 */
	async load(extPath: string, cwd: string, disabledComponents?: ReadonlySet<string>): Promise<DynamicPluginHandle> {
		const target = await resolveExtensionTarget(extPath);
		const existing = this.#records.get(target.name);
		if (existing?.status === "active") {
			throw new DynamicExtensionLoadError("collision", `extension "${target.name}" is already loaded`);
		}
		const record: DynamicPluginRecord = existing ?? {
			name: target.name,
			sourcePath: extPath,
			entryKey: target.entry,
			cwd,
			status: "active",
			components: new Map(),
		};
		record.status = "active";
		record.error = undefined;
		record.cwd = cwd;
		record.sourcePath = extPath;
		record.entryKey = target.entry;
		record.version = target.version;
		record.compatibility = undefined;
		record.components = new Map();
		this.#records.set(record.name, record);
		// 回退保护②：先于 import 的兼容性预检——拒绝 = failed 记录 + 结构化抛错,
		// exempted = 放行但保留标注（inspect/list 如实透出）。
		const gate = await this.#compatibilityPreflight(target);
		record.compatibility = gate;
		if (gate && gate.status !== "exempted") {
			record.status = "failed";
			record.error = pluginCompatibilityWarning(gate);
			throw new DynamicExtensionLoadError(gate.code, record.error);
		}
		if (gate) logger.warn("compatibility exemption active, loading anyway", { plugin: gate.plugin.name });
		await this.#mount(record, target, disabledComponents);
		// Record what the entry looked like as it was evaluated, so a later
		// reconcile can tell an edit from a no-op. `observe` takes the whole
		// active set: it replaces every record, so passing one entry would forget
		// the others and make them all look newly-loaded.
		this.#files.observe([...this.#records.values()].filter(r => r.status === "active").map(r => r.entryKey));
		return this.#buildHandle(record);
	}

	/**
	 * reconcile 批量装载（宿主级 getExtensionRuntimeLoad 的 fiber 路径）：
	 *  发现清单 ↔ 在役记录对账——消失的路径卸载（效果账本反向回收）、
	 *  新路径装载、**入口文件内容变了的在役插件重载**、其余不动。
	 *
	 * 第三项是 HMR 的核心：watcher 只报「这些根下面有东西动了」，要决定
	 * 重载哪个插件，必须把在役入口与它被求值时的磁盘身份比一次。比较规则
	 * （inode+size+mtime、不含 ctime、2 秒时间戳容差、标记文件取时钟）
	 * 见 {@link PluginFileIdentities}。
	 *
	 * 变更判定放在这里而不是 watcher 里，是因为 cordis 的装载是惰性的：
	 * watcher 只清缓存，真正 reconcile 的时机由下一次 RPC 决定——那时才知道
	 * 哪些入口还在役、该跟哪个 record 对账。
	 */
	async loadAll(
		paths: string[],
		cwd: string,
		disabledComponents?: ReadonlySet<string>,
	): Promise<LoadExtensionsResult> {
		const targets = new Map<string, ExtensionTarget>();
		const errors: Array<{ path: string; error: string }> = [];
		for (const input of paths) {
			try {
				const target = await resolveExtensionTarget(input);
				targets.set(target.entry, target);
			} catch (err) {
				errors.push({ path: input, error: err instanceof Error ? err.message : String(err) });
			}
		}
		// 消失的路径：卸载（登记随效果账本回收，如 design system 注销）。
		const activeEntries = [...this.#records.values()]
			.filter(record => record.status === "active")
			.map(record => record.entryKey);
		const { stale } = this.#files.compare(activeEntries);

		for (const record of [...this.#records.values()]) {
			if (record.status === "active" && !targets.has(record.entryKey)) {
				await this.#unloadRecord(record);
			}
		}
		// 在役但文件变了：就地重载（同一 record，不重新发现）。
		for (const record of [...this.#records.values()]) {
			if (record.status !== "active" || !stale.has(record.entryKey)) continue;
			try {
				await this.reloadPlugin(record.name);
				// 重载后记录新身份，否则下一轮比对仍判它 stale —— 会变成每次
				// reconcile 都重载一次。
				this.#files.refresh([record.entryKey]);
				logger.info("plugin reloaded after its entry changed on disk", { plugin: record.name });
			} catch (err) {
				errors.push({
					path: record.entryKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		// 新路径（或入口已改道的同名扩展）：装载；失败归 errors 不阻塞其余。
		for (const target of targets.values()) {
			const existing = this.#records.get(target.name);
			if (existing?.status === "active") {
				if (existing.entryKey === target.entry) continue;
				await this.#unloadRecord(existing);
			}
			try {
				await this.load(target.entry, cwd, disabledComponents);
			} catch (err) {
				errors.push({ path: target.entry, error: err instanceof Error ? err.message : String(err) });
			}
		}
		return {
			extensions: [...this.#records.values()]
				.filter(record => record.status === "active" && record.extension)
				.map(record => record.extension!),
			errors,
			runtime: await this.#sharedRuntime(),
		};
	}

	/** 装配落核：组 fiber 下挂子 fiber，apply = Track A 自有装载管线
	 *  （plugins/mount.ts：读入口形态 → inject 依赖门 → bind → 账本壳）。
	 *  `loadLegacyPiModule` 首次装载取进程内同一实例，reload 才重新求值——
	 *  于是 ext.call 与活跃会话看到同一份插件状态。bind 失败结构化上抛 →
	 *  fiber FAILED → 立即 dispose 不留半挂载。主 fiber 落定后按清单声明
	 *  挂组件子 fiber（层隔离：单组件失败只记 FAILED，插件与其余组件无损）。 */
	async #mount(
		record: DynamicPluginRecord,
		target: ExtensionTarget,
		disabledComponents?: ReadonlySet<string>,
		/** Reload re-evaluates the entry module; a first mount shares identity. */
		fresh = false,
	): Promise<void> {
		const group = await this.#ensureGroup();
		const fiber = group.ctx.plugin({
			name: `dynamic-extension:${record.name}`,
			apply: async ctx => {
				const { mountPlugin } = await import("../extensibility/plugins/mount");
				const { readPluginConfigStore } = await import("../extensibility/extensions-center/plugin-config-store");
				const { coerceConfigValues } = await import("@musepi/pi-wire");
				const { readExtensionPluginMeta } = await import("../extensibility/extensions/plugin-manifest");
				// Track A owns its own import + bind, so the entry's declared shape
				// (`inject` / `Config`) is honoured here instead of in the legacy
				// loader that Track B keeps byte-identical to upstream.
				const mounted = await mountPlugin({
					entryPath: target.entry,
					cwd: record.cwd,
					eventBus: this.#eventBus,
					runtime: await this.#sharedRuntime(),
					fresh,
					serviceRegistry: this.#serviceRegistry(),
					wrapApi: (api, extension) => this.#ledgerApi(record.name, api, extension, ctx),
					readConfig: async entryPath => {
						const meta = await readExtensionPluginMeta(entryPath);
						const store = await readPluginConfigStore();
						const id = `extension-module:${getExtensionNameFromPath(entryPath)}`;
						return {
							fields: meta?.fields ?? [],
							values: coerceConfigValues(meta?.fields ?? [], store[id]),
						};
					},
				});
				if (!mounted.ok) {
					// The mount pipeline's codes are already the structured ones
					// the management surface understands (it propagates a
					// ledger-thrown code verbatim rather than flattening it), so
					// this is a re-throw, not a translation.
					throw new DynamicExtensionLoadError(mounted.code, mounted.message);
				}
				record.extension = mounted.extension;
				record.ctx = ctx;
				record.declaredConfig = mounted.config;
				// Publish the services this plugin provides ONLY after a
				// successful mount: a name is real while its provider lives, so
				// recording it earlier would let a later plugin inject a service
				// whose provider then failed to load.
				this.#rememberProvidedServices(record.name, mounted.entry, mounted.published);
			},
		} satisfies Plugin.Object);
		record.fiber = fiber;
		try {
			await fiber.await();
		} catch (err) {
			// 失败不留挂载：dispose 后结构化记录（latestRun attempt 形状）。
			await fiber.dispose();
			// A plugin that threw may have written state before failing. Nothing
			// was registered past the throw, so there are no cleanups to run —
			// but the state is meaningless now and must not outlive the attempt.
			if (record.extension) {
				const { disposeFailedPluginPrimitives } = await import("../extensibility/plugins/cordis-primitives");
				disposeFailedPluginPrimitives(record.extension);
			}
			record.status = "failed";
			record.fiber = undefined;
			record.ctx = undefined;
			record.error = err instanceof Error ? err.message : String(err);
			throw err instanceof DynamicExtensionLoadError
				? err
				: new DynamicExtensionLoadError(
						"factory-threw",
						`extension "${record.name}" failed to load: ${record.error}`,
					);
		}
		await this.#mountComponents(record, target, disabledComponents, fresh);
	}

	/** 组件子 fiber 挂载：每个带 entry 且
	 *  未禁用的清单组件 = 插件 fiber 下的独立子 fiber，装载走与插件入口
	 *  完全相同的 importAndBindExtension 管线 + 效果账本（ledgerApi 的 owner
	 *  名 = `<plugin>/<component>`,跨组件命令碰撞结构化拒绝）。无 entry 的
	 *  组件如实记 disabled（只读展示声明,不发明启停语义）。 */
	async #mountComponents(
		record: DynamicPluginRecord,
		target: ExtensionTarget,
		disabledComponents?: ReadonlySet<string>,
		/** Reload re-evaluates each component entry too; a first mount shares. */
		fresh = false,
	): Promise<void> {
		for (const decl of target.components) {
			const component: DynamicComponentRecord = {
				id: decl.id,
				...(decl.description ? { description: decl.description } : {}),
				status: "disabled",
			};
			record.components.set(decl.id, component);
			if (!decl.entry) continue;
			if (disabledComponents?.has(`${record.name}/${decl.id}`)) continue;
			if (!record.ctx) {
				component.status = "failed";
				component.error = "plugin context unavailable";
				continue;
			}
			const entryAbs = path.resolve(target.manifestDir ?? path.dirname(target.entry), decl.entry);
			await this.#mountComponent(record, component, entryAbs, fresh);
		}
	}

	/** 挂单个组件 fiber（装载与热启用共用）；失败层隔离为 FAILED 记录。 */
	async #mountComponent(
		record: DynamicPluginRecord,
		component: DynamicComponentRecord,
		entryAbs: string,
		fresh = false,
	): Promise<void> {
		const owner = `${record.name}/${component.id}`;
		const ctx = record.ctx;
		if (!ctx) {
			component.status = "failed";
			component.error = "plugin context unavailable";
			return;
		}
		const fiber = ctx.plugin({
			name: `dynamic-extension-component:${owner}`,
			apply: async cctx => {
				// Components mount through Track A's pipeline too: they are part of
				// the same plugin, so identity, dependency gating and config all
				// follow the entry's rules rather than the legacy extension's.
				const { mountPlugin } = await import("../extensibility/plugins/mount");
				const mounted = await mountPlugin({
					entryPath: entryAbs,
					cwd: record.cwd,
					eventBus: this.#eventBus,
					runtime: await this.#sharedRuntime(),
					fresh,
					wrapApi: (api, extension) => this.#ledgerApi(owner, api, extension, cctx),
					readConfig: async entryPath => {
						const { readPluginConfigStore } = await import(
							"../extensibility/extensions-center/plugin-config-store"
						);
						const { coerceConfigValues } = await import("@musepi/pi-wire");
						const { readExtensionPluginMeta } = await import("../extensibility/extensions/plugin-manifest");
						const meta = await readExtensionPluginMeta(entryPath);
						const store = await readPluginConfigStore();
						const id = `extension-module:${getExtensionNameFromPath(entryPath)}`;
						const fields = meta?.fields ?? [];
						return { fields, values: coerceConfigValues(fields, store[id]) };
					},
				});
				if (!mounted.ok) {
					// Same as the plugin entry: re-throw, do not translate.
					throw new DynamicExtensionLoadError(mounted.code, mounted.message);
				}
				component.extension = mounted.extension;
			},
		} satisfies Plugin.Object);
		component.fiber = fiber;
		try {
			await fiber.await();
			component.status = "active";
			component.error = undefined;
		} catch (err) {
			await fiber.dispose().catch(() => {});
			component.status = "failed";
			component.fiber = undefined;
			component.error = err instanceof Error ? err.message : String(err);
			logger.warn("dynamic extension component mount failed", { owner, err });
		}
	}

	/** 组件独立启停（extensions.setComponentEnabled 的 user 插件径）：
	 *  停用 = dispose 组件 fiber（效果账本反向回收,登记随 fiber 生命周期走）；
	 *  启用 = 重挂组件 fiber（mtime 标签口径,改写即拾取）。仅 entry 组件
	 *  可切换;插件须在役。 */
	async setComponentEnabled(pluginName: string, componentId: string, enabled: boolean): Promise<void> {
		const record = this.#records.get(pluginName);
		if (record?.status !== "active") {
			throw new DynamicExtensionLoadError("entry-missing", `extension "${pluginName}" is not active`);
		}
		const component = record.components.get(componentId);
		if (!component) {
			throw new DynamicExtensionLoadError(
				"entry-missing",
				`extension "${pluginName}" has no declared component "${componentId}"`,
			);
		}
		if (enabled) {
			if (component.status === "active") return;
			const target = await resolveExtensionTarget(record.sourcePath);
			const decl = target.components.find(c => c.id === componentId);
			if (!decl?.entry) {
				throw new DynamicExtensionLoadError(
					"entry-missing",
					`component "${pluginName}/${componentId}" has no entry to mount`,
				);
			}
			const entryAbs = path.resolve(target.manifestDir ?? path.dirname(target.entry), decl.entry);
			component.status = "disabled";
			// Re-enabling is a re-mount of an entry that may have been edited while
			// disabled, so it re-evaluates like any other reload.
			await this.#mountComponent(record, component, entryAbs, true);
			return;
		}
		if (component.status !== "active") return;
		if (component.fiber) {
			await component.fiber.dispose().catch(() => {});
		}
		component.status = "disabled";
		component.fiber = undefined;
		component.extension = undefined;
	}

	/** 插件 fiber 卸载与重挂（plugins.setEnabled 的总闸语义）：
	 *  unload = 拆掉整个插件 fiber（效果账本反向回收，槽位组件/命令/provider
	 *  登记随生命周期消失）；reload = 卸载后按当前磁盘状态重挂。
	 *  未装载/已卸载的插件是幂等 no-op。 */
	async unloadPlugin(pluginName: string): Promise<void> {
		const record = this.#records.get(pluginName);
		if (!record) return;
		await this.#unloadRecord(record);
	}

	async reloadPlugin(pluginName: string): Promise<void> {
		const record = this.#records.get(pluginName);
		if (!record) return;
		await this.#unloadRecord(record);
		const target = await resolveExtensionTarget(record.sourcePath);
		record.entryKey = target.entry;
		record.status = "active";
		record.error = undefined;
		record.components = new Map();
		await this.#mount(record, target, undefined, true);
	}

	/** 效果账本壳：register 类动词/on 每次登记 = ctx.effect 一条带标签 effect，
	 *  dispose 即按 verb 撤销表反向回收；registerCommand 额外过跨扩展
	 *  碰撞守卫（先加载者归属不被抢）。 */
	#ledgerApi(name: string, api: ExtensionAPI, extension: Extension, ctx: Context): ExtensionAPI {
		// 注意：Proxy trap 内 this 指向 handler 对象，须箭头闭包包住运行时实例。
		const registrations = this.#registrations;
		return new Proxy(api, {
			get: (target, prop, receiver) => {
				const value = Reflect.get(target, prop, receiver);
				if (typeof prop !== "string" || typeof value !== "function" || !LEDGERED_VERBS.has(prop)) {
					return value;
				}
				return (...args: unknown[]) => {
					if (prop === "registerCommand") {
						const commandName = args[0];
						const owner =
							typeof commandName === "string" ? registrations.get(`command:${commandName}`) : undefined;
						if (owner !== undefined && owner !== name) {
							throw new DynamicExtensionLoadError(
								"collision",
								`command "${String(commandName)}" is already registered by extension "${owner}" — unload that extension first or pick another name`,
							);
						}
					}
					return ctx.effect(
						() => {
							if (prop === "registerCommand" && typeof args[0] === "string") {
								registrations.set(`command:${args[0]}`, name);
							}
							(value as (...inner: unknown[]) => void).apply(target, args);
							return undoRegistration(prop, api, extension, args);
						},
						effectLabel(prop, args),
					);
				};
			},
		}) as ExtensionAPI;
	}

	async #unloadRecord(record: DynamicPluginRecord): Promise<void> {
		if (record.status !== "active" || !record.fiber) return;
		const extension = record.extension;
		const components = [...record.components.values()];
		await record.fiber.dispose();
		// Services go first: nothing may inject a name whose provider is gone.
		this.#forgetProvidedServices(record.name);
		// The ledger undoes registrations; `pi.effect` cleanups are NOT
		// registrations, so they need their own pass. Running them after the
		// fiber is gone is deliberate: a cleanup that touches a registration
		// must see the world as it was, not a half-torn-down one.
		const { disposePluginPrimitives } = await import("../extensibility/plugins/cordis-primitives");
		if (extension) await disposePluginPrimitives(extension);
		// The component DECLARATIONS survive the unload: a package toggle is an
		// install/uninstall of the whole plugin, and the management surface
		// must keep listing what the plugin declares (with each row reading
		// its real, not-mounted state) instead of the rows vanishing — a
		// component list that disappears with the toggle cannot be managed.
		// Only the per-component runtime references are dropped; the map keys
		// are the manifest's declaration and stay put.
		for (const component of components) {
			if (component.extension) await disposePluginPrimitives(component.extension);
			component.status = "unloaded";
			component.fiber = undefined;
			component.extension = undefined;
		}
		record.status = "unloaded";
		record.fiber = undefined;
		record.ctx = undefined;
		record.extension = undefined;
	}

	#buildHandle(record: DynamicPluginRecord): DynamicPluginHandle {
		return {
			name: record.name,
			invoke: async (commandName, args = "") => {
				// 主入口优先,其后按声明序查在役组件（host-level 命令面 =
				// 插件 + 组件的并集;缺席 = 结构化「能力缺席」错误）。
				let command = record.extension?.commands.get(commandName);
				if (!command) {
					for (const component of record.components.values()) {
						if (component.status !== "active") continue;
						command = component.extension?.commands.get(commandName);
						if (command) break;
					}
				}
				if (!command) {
					throw new DynamicExtensionLoadError(
						"entry-missing",
						`extension "${record.name}" has no active command "${commandName}" (capability absent — extension unloaded, failed, or never registered it)`,
					);
				}
				return command.handler(args, HOST_COMMAND_CTX);
			},
			unload: async () => {
				await this.#unloadRecord(record);
			},
			reload: async () => {
				await this.#unloadRecord(record);
				const target = await resolveExtensionTarget(record.sourcePath);
				record.entryKey = target.entry;
				record.status = "active";
				record.error = undefined;
				record.components = new Map();
				await this.#mount(record, target, undefined, true);
			},
		};
	}

	/** 触发宿主事件，分发给所有已订阅扩展（宿主面事件总线，句柄外）。 */
	emit(event: string, ...args: unknown[]): void {
		for (const record of this.#records.values()) {
			if (record.status !== "active" || !record.extension) continue;
			const handlers = record.extension.handlers.get(event);
			if (!handlers) continue;
			for (const handler of [...handlers]) {
				try {
					handler(...args);
				} catch (err) {
					logger.warn("dynamic extension event handler threw", { name: record.name, err });
				}
			}
		}
	}

	/**
	 * Dispatch a `registerRpc` method on the CORDIS-MANAGED instance.
	 *
	 * Why this belongs here rather than in the artifact compiler: the compiler
	 * loads plugin entries through `loadLegacyPiModule`, which stamps every load
	 * with `?mtime=<tag>` so Bun rekeys the module (that is what makes HMR work).
	 * Two loaders therefore hold TWO module instances of the same plugin, and a
	 * module-level value written by one is invisible to the other — a real bug
	 * this session hit: a plugin captured the session context on one instance
	 * and its `ext.call` handler (other instance) saw `null`.
	 *
	 * Routing the RPC through the fiber-managed extension keeps ONE instance for
	 * both faces: registration state, closures and module-level caches are the
	 * same objects the session uses. Unload/reload dispose the fiber and this
	 * path follows automatically.
	 *
	 * Returns `undefined` when the name is not a cordis-managed plugin, so the
	 * caller can fall back to its own load path (e.g. a bare extension file that
	 * was never installed as a plugin package).
	 */
	async invokeRpc(
		entryPath: string,
		method: string,
		params: unknown,
		ctx: { cwd: string; sessionId?: string },
	): Promise<{ found: false } | { found: true; value: unknown }> {
		const target = path.resolve(entryPath);
		for (const record of this.#records.values()) {
			if (record.status !== "active" || !record.extension) continue;
			if (path.resolve(record.entryKey) !== target && path.resolve(record.sourcePath) !== target) {
				continue;
			}
			const handler = record.extension.rpcs.get(method);
			if (!handler) throw new Error(`unknown extension rpc method "${method}" (extension ${entryPath})`);
			return { found: true, value: await handler(params, ctx) };
		}
		return { found: false };
	}

	/** 检视面：每个动态扩展的状态 + fiber 效果账本标签 + 错误归因 +
	 *  组件装载面（fiber 状态机/效果账本,无 fiber 的组件如实缺项）。 */
	inspect(): DynamicPluginInspection[] {
		return [...this.#records.values()].map(record => ({
			name: record.name,
			status: record.status,
			version: record.version,
			fiberState: record.fiber ? (FIBER_STATE_NAMES[record.fiber.state] ?? String(record.fiber.state)) : undefined,
			effectLabels:
				record.fiber && record.fiber.state !== FIBER_STATE_FAILED
					? record.fiber.getEffects().map(effect => effect.label)
					: [],
			error: record.error,
			compatibility: record.compatibility,
			components: [...record.components.values()].map(component => ({
				id: component.id,
				status: component.status,
				fiberState: component.fiber
					? (FIBER_STATE_NAMES[component.fiber.state] ?? String(component.fiber.state))
					: undefined,
				effectLabels:
					component.fiber && component.fiber.state !== FIBER_STATE_FAILED
						? component.fiber.getEffects().map(effect => effect.label)
						: [],
				error: component.error,
			})),
		}));
	}

	/** 拆卸整个动态插件组（幂等）；宿主 Context 其余装配不受影响。 */
	async dispose(): Promise<void> {
		if (!this.#group) return;
		try {
			await this.#group.dispose();
		} catch (err) {
			logger.warn("CordisDynamicPluginRuntime: dispose non-fatal", { err });
		}
		this.#group = undefined;
		this.#records.clear();
		this.#files.clear();
	}
}
