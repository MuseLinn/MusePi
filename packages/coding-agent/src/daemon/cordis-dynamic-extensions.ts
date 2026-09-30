/**
 * M2-2.9 spike ①：动态插件运行时——真实 user 扩展经 cordis 装配内核装载，
 * 验证 Loader / 隔离 / 生命周期 / 检视四能力（对标 dsh cordis-host-runner）。
 *
 * 能力缝声明（M2-2.4）：
 * - 名称+ns：`cordis-dynamic-extensions`（daemon 装配面，spike 级）
 * - 输入：扩展目录（package.json `omp`/`pi.extensions` 入口，与 plugins/loader
 *   同一发现约定）+ DaemonHostContext 根 Context
 * - 输出：DynamicExtensionHandle（invoke/检视/unload/reload）+ 结构化加载错误
 * - 生命周期：每个扩展 = `musepi-dynamic-extensions` 组 fiber 下的独立子 fiber；
 *   每次登记 = fiber 效果账本（ctx.effect）上的一条带标签 effect，卸载即
 *   fiber.dispose() 反向回收（dsh lifecycle.ts「everything is an effect」parity）
 * - 启停：随 daemon 进程；runtime.dispose() 幂等拆卸整组
 * - 冲突：与 extensions/loader（静态装配权威）双轨并行——本文件是 spike 探针，
 *   试点通过前不接生产加载路径
 *
 * 与 dsh cordis-host-runner 的形态差异（如实记录，试点报告输入）：
 * - dsh 动态插件 = 模型生成的 host/client 双半体**代码字符串**，经 node:vm
 *   沙箱产出 cordis Plugin，apply 拿到的是真 ctx 的白名单 façade（guard.ts）。
 * - 我们动态装载的是**真实 user 扩展目录**（目录 + package.json + TS 入口），
 *   运行面是既有 pi.* ExtensionAPI——它本身就是 façade：user 代码永不接触
 *   cordis ctx，隔离由构造保证，不需要再包一层 vm（扩展已在宿主进程内以
 *   全权限运行，这与 dsh 模型生成代码的零信任前提根本不同）。
 * - cordis 在此纯做三件事：生命周期（fiber state 机 + dispose 效果回收）、
 *   登记守卫的落地载体（碰撞 = apply 抛错 = FAILED fiber，不留半挂载）、
 *   检视（fiber.state + getEffects() 效果账本诊断树）。
 * - HMR 实测口径（Windows + Bun 1.4.2 实测，试点报告输入）：
 *   · 裸 `import("file:///…?t=N")` 查询串**不能**击穿同进程模块缓存
 *     （探针实测：不同 query 返回同一实例）；
 *   · Bun.plugin onLoad 同样只按解析路径缓存——`?mtime=N` 第二次导入
 *     仍命中旧实例（探针实测 onLoad 只触发一次）；且 Bun 1.3.14+ 起
 *     onResolve 对运行时加载模块的传递导入不再触发（legacy-pi-compat.ts
 *     头部记录的已知限制），自定义命名空间方案不可用；
 *   · 可靠口径 = **整包暂存复制**：reload 时把扩展目录复制到 spike 私有
 *     暂存目录，新绝对路径即 Bun 模块缓存新键——入口与子模块改写均在
 *     reload 时拾取；watch 触发粒度契约（AGENTS.md：入口 mtime）不变。
 */

import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context, Fiber, Plugin } from "@deepseek-ai/cordis";
import { logger } from "@musepi/pi-utils";
import type { DaemonHostContext } from "./host-context";

/** 扩展目录 package.json 中声明的 omp/pi 字段形状（spike 窄面）。 */
interface ExtensionManifestPkg {
	name?: string;
	omp?: { extensions?: string[] };
	pi?: { extensions?: string[] };
}

/** fiber.state 数值镜像（cordis FiberState 是 const enum，跨模块不可 import；
 *  镜像必须与 vendor/cordis 的枚举序一致：PENDING..UNLOADING = 0..5）。 */
const FIBER_STATE_FAILED = 3;
const FIBER_STATE_NAMES = ["PENDING", "LOADING", "ACTIVE", "FAILED", "DISPOSED", "UNLOADING"] as const;

/** 探针 API：spike 窄面（生产接线时换 ConcreteExtensionAPI 同源工厂）。
 *  每个方法对应一种「登记 = fiber effect」的贡献面。 */
export interface DynamicExtensionProbeApi {
	/** 扩展名（package.json name）。 */
	readonly extensionName: string;
	/** 探针侧信道：扩展把可观测事件写入自己的探针日志（检视面 tail 可读）。 */
	emitProbe(line: string): void;
	/** 登记斜杠命令（kind = command，全局唯一，跨扩展碰撞结构化拒绝）。 */
	registerCommand(commandName: string, handler: (...args: string[]) => unknown): void;
	/** 订阅宿主事件（kind = event）。 */
	on(event: string, handler: (...args: unknown[]) => unknown): void;
	/** 注册周期回调（kind = interval，卸载即清除——效果账本反向回收的验证面）。 */
	setInterval(handler: () => void, ms: number): void;
}

export type DynamicExtensionFactory = (pi: DynamicExtensionProbeApi) => void | Promise<void>;

export interface DynamicExtensionInspection {
	name: string;
	status: "active" | "unloaded" | "failed";
	/** cordis fiber 生命周期状态名（FAILED 已拆卸的 fiber 无此项）。 */
	fiberState?: string;
	/** fiber 效果账本标签（检视 = getEffects() 诊断树，空数组表示已拆卸）。 */
	effectLabels: string[];
	probeLogTail: string[];
	error?: string;
}

/** 结构化加载错误（code 供管理面归因，message 为教学式文案）。 */
export class DynamicExtensionLoadError extends Error {
	constructor(
		readonly code: "entry-missing" | "manifest-invalid" | "collision" | "factory-threw",
		message: string,
	) {
		super(message);
		this.name = "DynamicExtensionLoadError";
	}
}

export interface DynamicExtensionHandle {
	readonly name: string;
	/** 调用该扩展登记的命令（不存在 = 结构化「能力缺席」错误——禁用兜底的渲染输入）。 */
	invoke(commandName: string, ...args: string[]): Promise<unknown>;
	/** 探针日志（含 tail 上限，防周期回调撑爆内存）。 */
	getProbeLog(): readonly string[];
	unload(): Promise<void>;
	/** 拆卸后按目录重新装载（入口文件改写即拾取新代码）。 */
	reload(): Promise<void>;
}

interface DynamicExtensionRecord {
	name: string;
	dir: string;
	status: "active" | "unloaded" | "failed";
	fiber?: Fiber;
	probeLog: string[];
	error?: string;
}

/** 探针日志 tail 上限（防 interval 探针无界增长）。 */
const PROBE_LOG_TAIL = 200;

/** 扩展 factory 的模块形状（default 导出或模块本体）。 */
type LoadedExtensionModule = DynamicExtensionFactory | { default?: DynamicExtensionFactory };

function getExtensionFactory(module: LoadedExtensionModule): DynamicExtensionFactory | null {
	const candidate = typeof module === "function" ? module : module.default;
	return typeof candidate === "function" ? candidate : null;
}

/** 整包暂存目录序列（每次装载递增，新路径 = Bun 模块缓存新键）。 */
let nextStageSeq = 1;

/**
 * 整包暂存复制导入（缓存击穿实测口径）：
 * Bun 1.4.2（Windows）下查询串与 Bun.plugin onLoad 均不能可靠击穿同进程
 * 模块缓存（本文件头注释的探针记录），唯一可靠口径是新绝对路径——把扩展
 * 目录复制到 spike 私有暂存目录后从暂存入口导入，入口与子模块都是新
 * specifier，reload 即拾取整包最新代码。
 */
async function importExtensionEntry(entry: string, extDir: string): Promise<unknown> {
	const stageRoot = path.join(os.tmpdir(), "musepi-cordis-spike-stage");
	const stageDir = path.join(stageRoot, `${Bun.hash(path.resolve(extDir)).toString(36)}-${nextStageSeq++}`);
	await fs.cp(extDir, stageDir, { recursive: true });
	return import(pathToFileURL(path.join(stageDir, path.relative(extDir, entry))).href);
}

/** 读扩展目录 package.json，解析 omp/pi.extensions 入口（与 plugins/loader
 *  resolveDirectoryEntries 同一约定：声明文件 → 自身；目录 → index.{ts,js,mjs,cjs}）。 */
async function resolveExtensionEntry(dir: string): Promise<{ name: string; entry: string }> {
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
	const declared = pkg.omp?.extensions ?? pkg.pi?.extensions ?? [];
	const first = declared[0];
	const joined = first ? path.resolve(dir, first) : dir;
	let stats: Stats;
	try {
		stats = await fs.stat(joined);
	} catch {
		throw new DynamicExtensionLoadError("entry-missing", `extension entry "${joined}" does not exist`);
	}
	let entry = joined;
	if (stats.isDirectory()) {
		entry = "";
		for (const ext of [".ts", ".js", ".mjs", ".cjs"]) {
			try {
				await fs.stat(path.join(joined, `index${ext}`));
				entry = path.join(joined, `index${ext}`);
				break;
			} catch {
				/* try next */
			}
		}
		if (!entry) {
			throw new DynamicExtensionLoadError("entry-missing", `extension directory "${joined}" has no index file`);
		}
	}
	return { name: pkg.name ?? path.basename(dir), entry };
}

export class CordisDynamicExtensionRuntime {
	readonly #host: DaemonHostContext;
	#group?: Fiber & PromiseLike<Fiber>;
	readonly #records = new Map<string, DynamicExtensionRecord>();
	/** 全局登记命名空间：kind:name → owner 扩展（跨扩展碰撞守卫）。 */
	readonly #registrations = new Map<string, string>();
	readonly #commands = new Map<string, { owner: string; handler: (...args: string[]) => unknown }>();
	readonly #listeners = new Map<string, Set<{ owner: string; handler: (...args: unknown[]) => unknown }>>();

	constructor(host: DaemonHostContext) {
		this.#host = host;
	}

	/** 动态插件组 fiber（dsh `cordis-dynamic` group parity）：首个 load 时创建，
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

	/** 装载一个真实 user 扩展目录为 cordis 动态插件。失败不留半挂载 fiber
	 *  （startHostHalf parity：FAILED fiber 立即 dispose）。同名扩展非 active
	 *  状态（failed/unloaded）时复用记录重载。 */
	async load(extDir: string): Promise<DynamicExtensionHandle> {
		const { name, entry } = await resolveExtensionEntry(extDir);
		const existing = this.#records.get(name);
		if (existing?.status === "active") {
			throw new DynamicExtensionLoadError("collision", `extension "${name}" is already loaded`);
		}
		const record: DynamicExtensionRecord = existing ?? { name, dir: extDir, status: "active", probeLog: [] };
		record.status = "active";
		record.error = undefined;
		this.#records.set(name, record);
		await this.#mount(record, entry);
		return this.#buildHandle(record);
	}

	/** 装配落核：组 fiber 下挂子 fiber，apply = 缓存击穿 import + factory 调用。 */
	async #mount(record: DynamicExtensionRecord, entry: string): Promise<void> {
		const group = await this.#ensureGroup();
		const fiber = group.ctx.plugin({
			name: `dynamic-extension:${record.name}`,
			apply: async ctx => {
				// 整包暂存复制：新绝对路径 = 新模块实例（入口与子模块均拾取最新代码）。
				const module = (await importExtensionEntry(entry, record.dir)) as LoadedExtensionModule;
				const factory = getExtensionFactory(module);
				if (!factory) {
					throw new DynamicExtensionLoadError(
						"manifest-invalid",
						`extension "${record.name}" entry has no factory export`,
					);
				}
				await factory(this.#buildProbeApi(record.name, ctx));
			},
		} satisfies Plugin.Object);
		record.fiber = fiber;
		try {
			await fiber.await();
		} catch (err) {
			// 失败不留挂载：dispose 后结构化记录（dsh latestRun attempt parity）。
			await fiber.dispose();
			record.status = "failed";
			record.fiber = undefined;
			record.error = err instanceof Error ? err.message : String(err);
			throw err instanceof DynamicExtensionLoadError
				? err
				: new DynamicExtensionLoadError(
						"factory-threw",
						`extension "${record.name}" failed to load: ${record.error}`,
					);
		}
	}

	/** 探针 API：每次登记 = ctx.effect 一条带标签 effect（卸载即回收）。 */
	#buildProbeApi(name: string, ctx: Context): DynamicExtensionProbeApi {
		const record = this.#records.get(name);
		const emitProbe = (line: string): void => {
			if (!record) return;
			record.probeLog.push(line);
			if (record.probeLog.length > PROBE_LOG_TAIL) {
				record.probeLog.splice(0, record.probeLog.length - PROBE_LOG_TAIL);
			}
		};
		const guardCollision = (kind: string, key: string): void => {
			const owner = this.#registrations.get(`${kind}:${key}`);
			if (owner !== undefined && owner !== name) {
				throw new DynamicExtensionLoadError(
					"collision",
					`${kind} "${key}" is already registered by extension "${owner}" — unload that extension first or pick another name`,
				);
			}
		};
		return {
			extensionName: name,
			emitProbe,
			registerCommand: (commandName, handler) => {
				guardCollision("command", commandName);
				ctx.effect(() => {
					this.#registrations.set(`command:${commandName}`, name);
					this.#commands.set(commandName, { owner: name, handler });
					return () => {
						this.#registrations.delete(`command:${commandName}`);
						this.#commands.delete(commandName);
					};
				}, `command:${commandName}`);
			},
			on: (event, handler) => {
				ctx.effect(() => {
					let set = this.#listeners.get(event);
					if (!set) {
						set = new Set();
						this.#listeners.set(event, set);
					}
					const listener = { owner: name, handler };
					set.add(listener);
					return () => {
						set.delete(listener);
					};
				}, `on:${event}`);
			},
			setInterval: (handler, ms) => {
				ctx.effect(() => {
					const handle = globalThis.setInterval(() => {
						try {
							handler();
						} catch (err) {
							logger.warn("dynamic extension interval threw", { name, err });
						}
					}, ms);
					return () => clearInterval(handle);
				}, `interval:${ms}ms`);
			},
		};
	}

	#buildHandle(record: DynamicExtensionRecord): DynamicExtensionHandle {
		return {
			name: record.name,
			invoke: async (commandName, ...args) => {
				const command = this.#commands.get(commandName);
				if (!command || command.owner !== record.name) {
					throw new DynamicExtensionLoadError(
						"entry-missing",
						`extension "${record.name}" has no active command "${commandName}" (capability absent — extension unloaded, failed, or never registered it)`,
					);
				}
				return command.handler(...args);
			},
			getProbeLog: () => record.probeLog,
			unload: async () => {
				if (record.status !== "active" || !record.fiber) return;
				await record.fiber.dispose();
				record.status = "unloaded";
				record.fiber = undefined;
			},
			reload: async () => {
				await this.#buildHandle(record).unload();
				const { entry } = await resolveExtensionEntry(record.dir);
				await this.#mount(record, entry);
			},
		};
	}

	/** 触发宿主事件，分发给所有已订阅扩展（宿主面事件总线，句柄外）。 */
	emit(event: string, ...args: unknown[]): void {
		const set = this.#listeners.get(event);
		if (!set) return;
		for (const listener of [...set]) {
			try {
				listener.handler(...args);
			} catch (err) {
				logger.warn("dynamic extension event handler threw", { name: listener.owner, err });
			}
		}
	}

	/** 检视面：每个动态扩展的状态 + fiber 效果账本标签 + 探针日志 tail + 错误归因。 */
	inspect(): DynamicExtensionInspection[] {
		return [...this.#records.values()].map(record => ({
			name: record.name,
			status: record.status,
			fiberState: record.fiber ? (FIBER_STATE_NAMES[record.fiber.state] ?? String(record.fiber.state)) : undefined,
			effectLabels:
				record.fiber && record.fiber.state !== FIBER_STATE_FAILED
					? record.fiber.getEffects().map(effect => effect.label)
					: [],
			probeLogTail: record.probeLog.slice(-10),
			error: record.error,
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
	}
}
