/**
 * M2-2.9 收编第二刀：user 插件宿主级 cordis 装载运行时（生产接线）。
 *
 * 能力缝声明（M2-2.4）：
 * - 名称+ns：`cordis-dynamic-extensions`（daemon 装配面，宿主级）
 * - 输入：扩展入口路径清单（discoverExtensionPaths 同源发现分支输出）+
 *   宿主 cwd + DaemonHostContext 根 Context
 * - 输出：LoadExtensionsResult（extensions/errors/runtime——与 loadExtensions
 *   同形状，供 session-less RPC 消费）+ DynamicExtensionHandle（invoke/
 *   检视/unload/reload）+ 结构化加载错误 + DynamicExtensionInspection[]
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
	compatibilityGateForExtensionPath,
	pluginCompatibilityWarning,
} from "../extensibility/plugins/plugin-compatibility";
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

export interface DynamicExtensionInspection {
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

export interface DynamicExtensionHandle {
	readonly name: string;
	/** 调用该扩展登记的命令（不存在 = 结构化「能力缺席」错误——禁用兜底的渲染输入）。
	 *  handler 签名为 (args, ctx)——宿主级无会话 ctx，默认存根在访问任何
	 *  字段时抛「需要会话」；忽略 ctx 的命令可直接调用。 */
	invoke(commandName: string, args?: string): Promise<unknown>;
	unload(): Promise<void>;
	/** 拆卸后按目录重新装载（入口文件改写即拾取新代码）。 */
	reload(): Promise<void>;
}

interface DynamicExtensionRecord {
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

export class CordisDynamicExtensionRuntime {
	readonly #host: DaemonHostContext;
	#group?: Fiber & PromiseLike<Fiber>;
	readonly #records = new Map<string, DynamicExtensionRecord>();
	/** 全局登记命名空间：command:name → owner 扩展（跨扩展碰撞守卫）。 */
	readonly #registrations = new Map<string, string>();
	/** 宿主级共享装配面：与 loadExtensions 每调用新建不同，fiber 运行时跨
	 *  reconcile 持久——登记随 fiber 生命周期走，TTL 重入不重复登记。 */
	#runtime: LoadExtensionsResult["runtime"] | null = null;
	readonly #eventBus = new EventBus();

	constructor(host: DaemonHostContext) {
		this.#host = host;
	}

	/** 动态插件组 fiber：首个 load 时创建，
	 *  所有动态扩展的子 fiber 挂在它下面，拆卸整组 = dispose 它一个。 */
	async #ensureGroup(): Promise<Fiber> {
		if (!this.#group) {
			const fiber = this.#host.plugin({ name: "musepi-dynamic-extensions", apply: () => {} });
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
	async load(extPath: string, cwd: string, disabledComponents?: ReadonlySet<string>): Promise<DynamicExtensionHandle> {
		const target = await resolveExtensionTarget(extPath);
		const existing = this.#records.get(target.name);
		if (existing?.status === "active") {
			throw new DynamicExtensionLoadError("collision", `extension "${target.name}" is already loaded`);
		}
		const record: DynamicExtensionRecord = existing ?? {
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
		return this.#buildHandle(record);
	}

	/** reconcile 批量装载（宿主级 getExtensionRuntimeLoad 的 fiber 路径）：
	 *  发现清单 ↔ 在役记录对账——消失的路径卸载（效果账本反向回收）、
	 *  新路径装载、在役不动（TTL 语义由调用方的缓存失效驱动）。聚合结果
	 *  与 loadExtensions 同形状（extensions/errors/runtime）。 */
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
		for (const record of [...this.#records.values()]) {
			if (record.status === "active" && !targets.has(record.entryKey)) {
				await this.#unloadRecord(record);
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

	/** 装配落核：组 fiber 下挂子 fiber，apply = 同源 import/bind（loadLegacyPiModule
	 *  每次装载自带单调 mtime 标签，Windows 下 raw-path 查询串即缓存新键——
	 *  入口与子模块改写 reload 即拾取）+ 效果账本壳。bind 失败结构化上抛 →
	 *  fiber FAILED → 立即 dispose 不留半挂载。主 fiber 落定后按清单声明
	 *  挂组件子 fiber（层隔离：单组件失败只记 FAILED，插件与其余组件无损）。 */
	async #mount(
		record: DynamicExtensionRecord,
		target: ExtensionTarget,
		disabledComponents?: ReadonlySet<string>,
	): Promise<void> {
		const group = await this.#ensureGroup();
		const fiber = group.ctx.plugin({
			name: `dynamic-extension:${record.name}`,
			apply: async ctx => {
				const { importAndBindExtension } = await import("../extensibility/extensions/loader");
				const bound = await importAndBindExtension(
					target.entry,
					record.cwd,
					this.#eventBus,
					await this.#sharedRuntime(),
					(api, extension) => this.#ledgerApi(record.name, api, extension, ctx),
				);
				if (bound.error || !bound.extension) {
					throw new DynamicExtensionLoadError(
						bound.code ?? "factory-threw",
						bound.error ?? `extension "${record.name}" failed to bind`,
					);
				}
				record.extension = bound.extension;
				record.ctx = ctx;
			},
		} satisfies Plugin.Object);
		record.fiber = fiber;
		try {
			await fiber.await();
		} catch (err) {
			// 失败不留挂载：dispose 后结构化记录（latestRun attempt 形状）。
			await fiber.dispose();
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
		await this.#mountComponents(record, target, disabledComponents);
	}

	/** 组件子 fiber 挂载：每个带 entry 且
	 *  未禁用的清单组件 = 插件 fiber 下的独立子 fiber，装载走与插件入口
	 *  完全相同的 importAndBindExtension 管线 + 效果账本（ledgerApi 的 owner
	 *  名 = `<plugin>/<component>`,跨组件命令碰撞结构化拒绝）。无 entry 的
	 *  组件如实记 disabled（只读展示声明,不发明启停语义）。 */
	async #mountComponents(
		record: DynamicExtensionRecord,
		target: ExtensionTarget,
		disabledComponents?: ReadonlySet<string>,
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
			await this.#mountComponent(record, component, entryAbs);
		}
	}

	/** 挂单个组件 fiber（装载与热启用共用）；失败层隔离为 FAILED 记录。 */
	async #mountComponent(
		record: DynamicExtensionRecord,
		component: DynamicComponentRecord,
		entryAbs: string,
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
				const { importAndBindExtension } = await import("../extensibility/extensions/loader");
				const bound = await importAndBindExtension(
					entryAbs,
					record.cwd,
					this.#eventBus,
					await this.#sharedRuntime(),
					(api, extension) => this.#ledgerApi(owner, api, extension, cctx),
				);
				if (bound.error || !bound.extension) {
					throw new DynamicExtensionLoadError(
						bound.code ?? "factory-threw",
						bound.error ?? `component "${owner}" failed to bind`,
					);
				}
				component.extension = bound.extension;
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
			await this.#mountComponent(record, component, entryAbs);
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

	async #unloadRecord(record: DynamicExtensionRecord): Promise<void> {
		if (record.status !== "active" || !record.fiber) return;
		await record.fiber.dispose();
		record.status = "unloaded";
		record.fiber = undefined;
		record.ctx = undefined;
		record.extension = undefined;
		for (const component of record.components.values()) {
			component.status = "unloaded";
			component.fiber = undefined;
			component.extension = undefined;
		}
	}

	#buildHandle(record: DynamicExtensionRecord): DynamicExtensionHandle {
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
				await this.#mount(record, target);
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

	/** 检视面：每个动态扩展的状态 + fiber 效果账本标签 + 错误归因 +
	 *  组件装载面（fiber 状态机/效果账本,无 fiber 的组件如实缺项）。 */
	inspect(): DynamicExtensionInspection[] {
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
			logger.warn("CordisDynamicExtensionRuntime: dispose non-fatal", { err });
		}
		this.#group = undefined;
		this.#records.clear();
	}
}
