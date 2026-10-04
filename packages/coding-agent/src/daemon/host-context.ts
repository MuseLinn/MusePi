import { Context, type Fiber, type Plugin } from "@deepseek-ai/cordis";
import { logger } from "@musepi/pi-utils";
import { BUILTIN_EXTENSIONS, type BuiltinExtensionDef } from "../extensibility/extensions-center/builtin-registry";
import { makeExtensionId } from "../extensibility/extensions-center/types";
import type { DaemonService } from "./services/types";

/** cordis fiber 状态名镜像（cordis FiberState 是 const enum,跨模块不可
 *  import;镜像必须与 vendor/cordis 的枚举序一致：0..5）。 */
const FIBER_STATE_NAMES = ["PENDING", "LOADING", "ACTIVE", "FAILED", "DISPOSED", "UNLOADING"] as const;
const FIBER_STATE_FAILED = 3;

function fiberStateName(fiber: Fiber): string {
	return FIBER_STATE_NAMES[fiber.state] ?? String(fiber.state);
}

/**
 * daemon 宿主 cordis 组合内核（P2 首刀，ADR 0001「cordis 收编边界与分层纪律」）。
 *
 * 能力缝声明（M2-2.4）：
 * - 输入：DaemonServer 构造完成后的 L2 服务集合（HostServices 注册表的
 *   同源实例，本文件是唯一 cordis 适配点——ADR 边界 2）。
 * - 输出：cordis 根 Context 上的服务提供（`ctx.<key>` 可解析）、检视面
 *   （registry size / 挂载键清单）、orderly shutdown 通路（fiber.dispose）。
 * - 生命周期：**逐服务声明**（`MountRegistryOptions.lifecycleByKey`）。未列入的
 *   服务 start/stop 权威仍在 P1 代码，挂载时代调——strangler-fig 的可回滚承诺
 *   由此成立（Context 拆掉即回 P1 形态）。列入 `"cordis"` 的服务由 apply 代调
 *   start、disposer 反向回收 stop：语义从"手写纪律"升级为"框架保证"，且
 *   disposer 一定跑得到（手写调用没有这个对称面）。当前唯一列入者是 schedule
 *   （收编第二刀）；其余服务逐个翻。
 * - 启停：随 daemon 进程创建/消亡；`dispose()` 在 daemon close 路径调用。
 *   冲突：路由唯一归属仍由 HostServices.routeTable 强制，cordis 不参与
 *   路由分发（垫片期注册表是 dispatch 权威）。
 *
 * 测试纪律（ADR 边界 3）：用真 cordis Context（纯内存、无 IO），不 mock。
 */

/** 挂载期选项。 */
export interface MountOptions {
	/**
	 * 生命周期权威："external"（默认，P2 双跑期）——挂载只 provide 不代调
	 * start/stop；"cordis"——start 即 apply、stop 即 disposer（effect 账本
	 * 反向回收），仅对已确认无副作用重复的服务启用。
	 */
	lifecycle?: "external" | "cordis";
}

export class DaemonHostContext {
	readonly #root = new Context();
	readonly #fibers = new Map<string, Fiber & PromiseLike<Fiber>>();
	/** builtin 插件单元 fiber（收编第一刀：非 annotate 单元各挂一个子
	 *  fiber,键 = extension id）——运行状态（fiberPhase）的真实数据源。 */
	readonly #builtinFibers = new Map<string, Fiber>();

	/** 挂载一个 L2 服务为 cordis 插件（provide = 服务键，未来 ctx.<key>）。
	 *  返回 fiber 句柄：await 它即等挂载落定（apply 完成、服务可解析）。 */
	mount(service: DaemonService, opts?: MountOptions): Fiber & PromiseLike<Fiber> {
		const key = service.key;
		if (this.#fibers.has(key)) {
			throw new Error(`DaemonHostContext: duplicate service key "${key}"`);
		}
		const lifecycle = opts?.lifecycle ?? "external";
		const fiber = this.plugin({
			name: `daemon-service:${key}`,
			apply: ctx => {
				if (lifecycle === "cordis") service.start?.();
				ctx.provide(key, service);
				if (lifecycle === "cordis") return () => service.stop?.();
			},
		});
		this.#fibers.set(key, fiber);
		return fiber;
	}

	/** 在根 Context 上直接装配一个任意 cordis 对象插件（fiber 由调用方持有）。
	 *  用于注册表之外的装配面——动态插件组（M2-2.9 spike ①）等。
	 *  返回 fiber 句柄：await 它即等挂载落定；挂载失败 fiber 进入 FAILED。 */
	plugin(definition: Plugin.Object): Fiber & PromiseLike<Fiber> {
		const fiber = this.#root.plugin(definition);
		Promise.resolve(fiber).catch(err => {
			logger.error("DaemonHostContext: plugin mount failed", { name: definition.name, err });
		});
		return fiber;
	}

	/** 双跑校验/调试入口：cordis 侧解析服务（与注册表同源实例）。 */
	get<T extends DaemonService>(key: string): T | undefined {
		return this.#root.get(key, false) as T | undefined;
	}

	/** 检视面：已挂载键 + cordis 注册表规模（cordisInspect 等价物的最小集）。 */
	inspect(): { keys: string[]; registrySize: number } {
		return { keys: [...this.#fibers.keys()], registrySize: this.#root.registry.size };
	}

	/**
	 * 收编第一刀：把 builtin 注册表单元挂为 cordis builtin 插件组
	 * （`musepi-builtin-plugins`）下的独立子 fiber——与 user 动态插件
	 * 同一装配语法、不同信任级（trust: builtin）。每个非 annotate 单元
	 * 一个 fiber,apply 提供 `builtin:<id>` 键（builtin 可声明宿主级
	 * inject 的落点,设计稿 §1 第 3 步）。生命周期 external（双跑期不代调
	 * start/stop）；装载失败的单元记 FAILED fiber 并归因,不拖垮组。
	 */
	mountBuiltinPlugins(defs: readonly BuiltinExtensionDef[] = BUILTIN_EXTENSIONS): Promise<void> {
		const units = defs.filter(d => !d.annotate);
		if (units.length === 0) return Promise.resolve();
		const group = this.plugin({ name: "musepi-builtin-plugins", apply: () => {} });
		return Promise.resolve(group)
			.then(async g => {
				for (const def of units) {
					const id = makeExtensionId(def.kind, def.name);
					const fiber = g.ctx.plugin({
						name: `builtin-plugin:${id}`,
						apply: ctx => {
							ctx.provide(`builtin:${id}`, def);
						},
					} satisfies Plugin.Object);
					this.#builtinFibers.set(id, fiber);
					try {
						await fiber.await();
					} catch (err) {
						// 层隔离（回退保护①）：单单元失败只记 FAILED,组与其余
						// 单元不受影响;错误归因进日志,管理面经 builtinInspect 读状态。
						logger.error("DaemonHostContext: builtin plugin mount failed", { id, err });
					}
				}
			})
			.catch(err => {
				logger.error("DaemonHostContext: builtin plugin group failed", { err });
			});
	}

	/** builtin 单元的 cordis 运行状态检视（extensions.list 的 runtime 面；
	 *  未挂载/已拆卸的单元不出现在结果里——如实,不编造）。 */
	builtinInspect(): Record<string, { fiberState: string; effects: number }> {
		const out: Record<string, { fiberState: string; effects: number }> = {};
		for (const [id, fiber] of this.#builtinFibers) {
			out[id] = {
				fiberState: fiberStateName(fiber),
				effects: fiber.state === FIBER_STATE_FAILED ? 0 : fiber.getEffects().length,
			};
		}
		return out;
	}

	/** 拆卸根 Context：插件 fiber 全量卸载。双跑期（external 生命周期）
	 *  不触碰服务 stop——回滚后 P1 代码路径不受影响。幂等。 */
	async dispose(): Promise<void> {
		try {
			await this.#root.fiber.dispose();
		} catch (err) {
			logger.warn("DaemonHostContext: dispose non-fatal", { err });
		}
		this.#fibers.clear();
		this.#builtinFibers.clear();
	}
}

/** mountRegistryServices 的挂载期选项。 */
export interface MountRegistryOptions {
	/** 按服务键指定生命周期权威，缺省即全部 "external"（P2 双跑默认）。
	 *  翻成 "cordis" 的服务由 apply 代调 start、disposer 代调 stop——收编刀口
	 *  按服务逐个推进，未翻的仍由 P1 代码掌管生命周期。 */
	lifecycleByKey?: Readonly<Record<string, "external" | "cordis">>;
}

/** L2 服务挂载失败（daemon 启动期契约）。
 *
 * 失败必须在启动期暴露。服务缺席时路由表仍认领它的 RPC，调用会一路走到
 * 派发才炸在一个与根因无关的位置（spike 报告「启动失败传播」：daemon 要求
 * 服务 start 失败 = 进程启动失败）。带上服务键，运维才知道该看哪个服务。
 */
export class DaemonServiceMountError extends Error {
	readonly serviceKey: string;

	constructor(serviceKey: string, cause: unknown) {
		super(`Daemon service "${serviceKey}" failed to mount on the cordis host context`, { cause });
		this.name = "DaemonServiceMountError";
		this.serviceKey = serviceKey;
	}
}

/** 便捷工厂：把注册表里的全部服务以 external 生命周期挂载（P2 双跑默认）
 *  并**按注册序 await** 落定。
 *
 * 返回 fiber 句柄供调用方继续持有。任何一个服务 apply 抛错即以
 * {@link DaemonServiceMountError} 中止——调用方据此让 daemon 启动失败。
 * 重复键这类编程错误在挂载期就地抛（不进 await 循环），保持栈可读。
 */
export async function mountRegistryServices(
	hostContext: DaemonHostContext,
	services: Iterable<DaemonService>,
	options?: MountRegistryOptions,
): Promise<(Fiber & PromiseLike<Fiber>)[]> {
	const mounted: { key: string; fiber: Fiber & PromiseLike<Fiber> }[] = [];
	for (const service of services) {
		const lifecycle = options?.lifecycleByKey?.[service.key];
		mounted.push({
			key: service.key,
			fiber: hostContext.mount(service, lifecycle ? { lifecycle } : undefined),
		});
	}
	for (const { key, fiber } of mounted) {
		try {
			await fiber;
		} catch (err) {
			throw new DaemonServiceMountError(key, err);
		}
	}
	return mounted.map(m => m.fiber);
}
